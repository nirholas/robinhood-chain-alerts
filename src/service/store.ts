import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAddress, type Address } from 'viem'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { PoolEntry, PoolRegistry } from '../events/registry.js'
import type { Launchpad } from '../events/types.js'
import type { RateLimitStore } from '../rules/ratelimit.js'
import { parseSubscription, type Platform, type Subscription } from '../rules/schema.js'
import type { WalletLinkStore } from '../tiers/entitlements.js'
import { decode, encode } from './codec.js'

// `node:sqlite` is a core module but is not in vite's static builtin list, so a
// plain `import` gets mis-resolved under vitest (vite tries, and fails, to
// bundle it as a bare package). `require()` is opaque to vite's ESM import
// analysis, which sidesteps the issue; Node natively supports requiring core
// modules from ESM through `createRequire`.
//
// The resolution base needs the `??`: in the CJS build there is no
// `import.meta`, and the bundler's shim leaves `url` undefined, which
// `createRequire` rejects outright. Any absolute path is a valid base here
// because a core module never resolves relative to it.
const requireFromHere = createRequire(
  (import.meta.url as string | undefined) ?? `${process.cwd()}/`,
)
const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite')

/**
 * All durable service state, in one SQLite file, with no native dependency.
 *
 * The three invariants this schema exists to guarantee, in order of how badly
 * they bite when they are missing:
 *
 * 1. **A restart never double-sends.** Every potential delivery has a
 *    deterministic primary key (`eventId:subscriptionId:ruleId`), and
 *    `enqueue` is an `INSERT` that reports a uniqueness violation as "already
 *    queued". Re-processing a block range after a crash regenerates the exact
 *    same keys, so the second pass inserts nothing.
 * 2. **A restart never silently skips a range.** The block cursor advances
 *    only after every event in a chunk has been enqueued and committed. A
 *    crash mid-chunk leaves the cursor pointing at the start of that chunk, so
 *    the range is simply re-read.
 * 3. **A crash between enqueue and send does not lose the alert.** Enqueued
 *    rows live in the outbox until they are delivered or dead-lettered. On
 *    startup, rows left in `sending` (a crash mid-flight) are returned to
 *    `pending` and retried.
 *
 * The one honest caveat: if the process dies after the platform accepted a
 * message but before the row was marked `sent`, that alert is delivered twice.
 * Neither the Telegram nor the Discord send API exposes a client-supplied
 * idempotency key, so this window cannot be closed from here. Everything
 * outside it is exactly once.
 */

/** Delivery lifecycle. */
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead'

/** A queued delivery. */
export interface OutboxRow {
  id: string
  subscriptionId: string
  subscriberId: string
  ruleId: string
  eventId: string
  eventJson: string
  platform: Platform
  target: string
  status: OutboxStatus
  /** Earliest delivery time, ms since epoch. Carries the free-tier delay. */
  notBeforeMs: number
  attempts: number
  lastError: string | null
  createdAtMs: number
  updatedAtMs: number
}

/** Aggregate counters for `/metrics`. */
export interface StoreMetrics {
  subscriptions: number
  enabledSubscriptions: number
  outbox: Record<OutboxStatus, number>
  pools: number
  deliveriesLastHour: number
  cursors: { sourceId: string; nextBlock: bigint }[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  platform      TEXT NOT NULL,
  target        TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  rules         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_id);

CREATE TABLE IF NOT EXISTS cursors (
  source_id  TEXT PRIMARY KEY,
  next_block TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  subscriber_id   TEXT NOT NULL,
  rule_id         TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  event_json      TEXT NOT NULL,
  platform        TEXT NOT NULL,
  target          TEXT NOT NULL,
  status          TEXT NOT NULL,
  not_before      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, not_before);
CREATE INDEX IF NOT EXISTS idx_outbox_event ON outbox(event_id);

CREATE TABLE IF NOT EXISTS deliveries (
  key           TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_key ON deliveries(key, at);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscriber ON deliveries(subscriber_id, at);

CREATE TABLE IF NOT EXISTS pools (
  pool          TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  quote_token   TEXT NOT NULL,
  launchpad     TEXT NOT NULL,
  created_block TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token);
CREATE INDEX IF NOT EXISTS idx_pools_created ON pools(created_block);

CREATE TABLE IF NOT EXISTS wallet_links (
  subscriber_id TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  linked_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS link_nonces (
  subscriber_id TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  issued_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface SubscriptionRow {
  id: string
  subscriber_id: string
  platform: string
  target: string
  enabled: number
  rules: string
  created_at: number
}

interface RawOutboxRow {
  id: string
  subscription_id: string
  subscriber_id: string
  rule_id: string
  event_id: string
  event_json: string
  platform: string
  target: string
  status: string
  not_before: number
  attempts: number
  last_error: string | null
  created_at: number
  updated_at: number
}

/** The service's durable state. */
export class AlertStore {
  private readonly db: DatabaseSyncType
  private readonly clock: () => number

  constructor(path: string, clock: () => number = () => Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.clock = clock
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  /** Deterministic outbox key. The whole dedupe guarantee rests on this. */
  static deliveryKey(eventId: string, subscriptionId: string, ruleId: string): string {
    return `${eventId}|${subscriptionId}|${ruleId}`
  }

  // ---- cursors -----------------------------------------------------------

  /** The next unprocessed block for a source, or `null` when never persisted. */
  getCursor(sourceId: string): bigint | null {
    const row = this.db.prepare('SELECT next_block FROM cursors WHERE source_id = ?').get(sourceId) as
      | { next_block: string }
      | undefined
    return row ? BigInt(row.next_block) : null
  }

  /** Persist the next unprocessed block. Call only after the range is enqueued. */
  setCursor(sourceId: string, nextBlock: bigint): void {
    this.db
      .prepare(
        `INSERT INTO cursors (source_id, next_block, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET next_block = excluded.next_block, updated_at = excluded.updated_at`,
      )
      .run(sourceId, nextBlock.toString(), this.clock())
  }

  /** Every persisted cursor, for `/metrics` and for operator inspection. */
  listCursors(): { sourceId: string; nextBlock: bigint }[] {
    const rows = this.db.prepare('SELECT source_id, next_block FROM cursors ORDER BY source_id').all() as Array<{
      source_id: string
      next_block: string
    }>
    return rows.map((row) => ({ sourceId: row.source_id, nextBlock: BigInt(row.next_block) }))
  }

  // ---- subscriptions -----------------------------------------------------

  /** Insert or replace a subscription. */
  saveSubscription(subscription: Subscription): void {
    const now = this.clock()
    this.db
      .prepare(
        `INSERT INTO subscriptions (id, subscriber_id, platform, target, enabled, rules, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           subscriber_id = excluded.subscriber_id,
           platform = excluded.platform,
           target = excluded.target,
           enabled = excluded.enabled,
           rules = excluded.rules,
           updated_at = excluded.updated_at`,
      )
      .run(
        subscription.id,
        subscription.subscriberId,
        subscription.platform,
        subscription.target,
        subscription.enabled ? 1 : 0,
        encode(subscription.rules),
        subscription.createdAtMs,
        now,
      )
  }

  private hydrate(row: SubscriptionRow): Subscription {
    return parseSubscription({
      id: row.id,
      subscriberId: row.subscriber_id,
      platform: row.platform,
      target: row.target,
      enabled: row.enabled === 1,
      rules: decode(row.rules),
      createdAtMs: row.created_at,
    })
  }

  /** One subscription by id. */
  getSubscription(id: string): Subscription | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
      | SubscriptionRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  /** Every subscription owned by a subscriber. */
  listSubscriptionsFor(subscriberId: string): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions WHERE subscriber_id = ? ORDER BY created_at')
      .all(subscriberId) as unknown as SubscriptionRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /** Every enabled subscription, for the dispatch fan-out. */
  listEnabledSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY created_at')
      .all() as unknown as SubscriptionRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /** Remove a subscription. Returns `true` when a row was deleted. */
  deleteSubscription(id: string): boolean {
    const result = this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** Every token on any enabled subscription's watchlist, deduped. */
  watchlistTokens(): Address[] {
    const seen = new Set<string>()
    for (const subscription of this.listEnabledSubscriptions()) {
      for (const rule of subscription.rules) {
        for (const token of rule.tokens) seen.add(token.toLowerCase())
      }
    }
    return [...seen].map((token) => getAddress(token as Address))
  }

  // ---- outbox ------------------------------------------------------------

  /**
   * Queue a delivery.
   *
   * @returns `true` when this call created the row, `false` when it already
   * existed (a replayed block range, a duplicate log). The boolean is the
   * dedupe signal the dispatcher counts.
   */
  enqueue(row: Omit<OutboxRow, 'status' | 'attempts' | 'lastError' | 'createdAtMs' | 'updatedAtMs'>): boolean {
    const now = this.clock()
    try {
      this.db
        .prepare(
          `INSERT INTO outbox (id, subscription_id, subscriber_id, rule_id, event_id, event_json,
                               platform, target, status, not_before, attempts, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?)`,
        )
        .run(
          row.id,
          row.subscriptionId,
          row.subscriberId,
          row.ruleId,
          row.eventId,
          row.eventJson,
          row.platform,
          row.target,
          row.notBeforeMs,
          now,
          now,
        )
      return true
    } catch (error) {
      // A UNIQUE violation is the expected path for a replay. Anything else is
      // a real storage failure and must not be swallowed.
      const message = error instanceof Error ? error.message : String(error)
      if (/UNIQUE|PRIMARY KEY/i.test(message)) return false
      throw error
    }
  }

  private static toOutboxRow(raw: RawOutboxRow): OutboxRow {
    return {
      id: raw.id,
      subscriptionId: raw.subscription_id,
      subscriberId: raw.subscriber_id,
      ruleId: raw.rule_id,
      eventId: raw.event_id,
      eventJson: raw.event_json,
      platform: raw.platform as Platform,
      target: raw.target,
      status: raw.status as OutboxStatus,
      notBeforeMs: raw.not_before,
      attempts: raw.attempts,
      lastError: raw.last_error,
      createdAtMs: raw.created_at,
      updatedAtMs: raw.updated_at,
    }
  }

  /**
   * Claim due deliveries, moving them to `sending` in one transaction so a
   * second flush pass cannot pick up the same rows.
   */
  claimDue(nowMs: number, limit: number): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('pending', 'failed') AND not_before <= ?
         ORDER BY not_before, created_at
         LIMIT ?`,
      )
      .all(nowMs, limit) as unknown as RawOutboxRow[]
    if (rows.length === 0) return []

    const update = this.db.prepare(`UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ?`)
    this.db.exec('BEGIN')
    try {
      for (const row of rows) update.run(nowMs, row.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return rows.map((row) => AlertStore.toOutboxRow(row))
  }

  /** Mark a delivery sent. */
  markSent(id: string): void {
    this.db
      .prepare(`UPDATE outbox SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(this.clock(), id)
  }

  /** Record a retryable failure and schedule the next attempt. */
  markFailed(id: string, attempts: number, error: string, nextAttemptAtMs: number): void {
    this.db
      .prepare(
        `UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, not_before = ?, updated_at = ? WHERE id = ?`,
      )
      .run(attempts, error, nextAttemptAtMs, this.clock(), id)
  }

  /** Give up on a delivery (permanent rejection, or attempts exhausted). */
  markDead(id: string, attempts: number, error: string): void {
    this.db
      .prepare(`UPDATE outbox SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(attempts, error, this.clock(), id)
  }

  /**
   * Return rows abandoned mid-flight by a crash to the queue.
   *
   * @returns how many rows were recovered.
   */
  recoverInFlight(): number {
    const result = this.db
      .prepare(`UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'sending'`)
      .run(this.clock())
    return Number(result.changes)
  }

  /** Delete delivered rows older than `beforeMs`, keeping the file bounded. */
  pruneOutbox(beforeMs: number): number {
    const result = this.db
      .prepare(`DELETE FROM outbox WHERE status = 'sent' AND updated_at < ?`)
      .run(beforeMs)
    return Number(result.changes)
  }

  /** Delete delivery history older than `beforeMs`. */
  pruneDeliveries(beforeMs: number): number {
    const result = this.db.prepare('DELETE FROM deliveries WHERE at < ?').run(beforeMs)
    return Number(result.changes)
  }

  // ---- rate limiting and throughput --------------------------------------

  /** A {@link RateLimitStore} backed by the `deliveries` table. */
  rateLimitStore(): RateLimitStore {
    return {
      countSince: async (key: string, sinceMs: number): Promise<number> => {
        const row = this.db
          .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE key = ? AND at >= ?')
          .get(key, sinceMs) as { n: number }
        return Number(row.n)
      },
      lastAt: async (key: string): Promise<number | null> => {
        const row = this.db
          .prepare('SELECT MAX(at) AS last FROM deliveries WHERE key = ?')
          .get(key) as { last: number | null }
        return row.last ?? null
      },
      record: async (key: string, subscriberId: string, atMs: number): Promise<void> => {
        this.recordDelivery(key, subscriberId, atMs)
      },
      countForSubscriberSince: async (subscriberId: string, sinceMs: number): Promise<number> => {
        return this.countDeliveriesForSubscriber(subscriberId, sinceMs)
      },
    }
  }

  /** Record a delivery for both rate limiting and throughput accounting. */
  recordDelivery(key: string, subscriberId: string, atMs: number): void {
    this.db.prepare('INSERT INTO deliveries (key, subscriber_id, at) VALUES (?, ?, ?)').run(key, subscriberId, atMs)
  }

  /** How many alerts a subscriber received since `sinceMs`. */
  countDeliveriesForSubscriber(subscriberId: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE subscriber_id = ? AND at >= ?')
      .get(subscriberId, sinceMs) as { n: number }
    return Number(row.n)
  }

  // ---- pool registry -----------------------------------------------------

  /** A {@link PoolRegistry} backed by the `pools` table. */
  poolRegistry(): PoolRegistry {
    return {
      record: async (entry: PoolEntry): Promise<void> => {
        this.db
          .prepare(
            `INSERT INTO pools (pool, token, quote_token, launchpad, created_block) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(pool) DO UPDATE SET
               token = excluded.token, quote_token = excluded.quote_token,
               launchpad = excluded.launchpad, created_block = excluded.created_block`,
          )
          .run(
            getAddress(entry.pool),
            getAddress(entry.token),
            getAddress(entry.quoteToken),
            entry.launchpad,
            entry.createdBlock.toString(),
          )
      },
      active: async (limit: number, pinned: readonly Address[] = []): Promise<PoolEntry[]> => {
        const picked = new Map<string, PoolEntry>()
        if (pinned.length > 0) {
          const placeholders = pinned.map(() => '?').join(',')
          const rows = this.db
            .prepare(`SELECT * FROM pools WHERE lower(token) IN (${placeholders})`)
            .all(...pinned.map((token) => token.toLowerCase())) as Array<Record<string, string>>
          for (const row of rows) {
            const entry = AlertStore.toPoolEntry(row)
            picked.set(entry.pool.toLowerCase(), entry)
          }
        }
        const rows = this.db
          .prepare(
            // created_block is stored as text to keep bigint precision, so it
            // is ordered numerically by length first, then lexically.
            'SELECT * FROM pools ORDER BY length(created_block) DESC, created_block DESC LIMIT ?',
          )
          .all(limit) as Array<Record<string, string>>
        for (const row of rows) {
          if (picked.size >= limit + pinned.length) break
          const entry = AlertStore.toPoolEntry(row)
          if (!picked.has(entry.pool.toLowerCase())) picked.set(entry.pool.toLowerCase(), entry)
        }
        return [...picked.values()]
      },
      originOf: async (token: Address): Promise<Launchpad | null> => {
        const row = this.db
          .prepare('SELECT launchpad FROM pools WHERE lower(token) = ? LIMIT 1')
          .get(token.toLowerCase()) as { launchpad: string } | undefined
        return row ? (row.launchpad as Launchpad) : null
      },
      poolsFor: async (token: Address): Promise<PoolEntry[]> => {
        const rows = this.db
          .prepare('SELECT * FROM pools WHERE lower(token) = ?')
          .all(token.toLowerCase()) as Array<Record<string, string>>
        return rows.map((row) => AlertStore.toPoolEntry(row))
      },
      size: async (): Promise<number> => {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM pools').get() as { n: number }
        return Number(row.n)
      },
    }
  }

  private static toPoolEntry(row: Record<string, string>): PoolEntry {
    return {
      pool: getAddress(row['pool'] as Address),
      token: getAddress(row['token'] as Address),
      quoteToken: getAddress(row['quote_token'] as Address),
      launchpad: row['launchpad'] as Launchpad,
      createdBlock: BigInt(row['created_block'] as string),
    }
  }

  // ---- wallet links ------------------------------------------------------

  /** Store a signature-verified wallet link. */
  linkWallet(subscriberId: string, address: Address): void {
    this.db
      .prepare(
        `INSERT INTO wallet_links (subscriber_id, address, linked_at) VALUES (?, ?, ?)
         ON CONFLICT(subscriber_id) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at`,
      )
      .run(subscriberId, getAddress(address), this.clock())
  }

  /** A {@link WalletLinkStore} view of the links table. */
  walletLinks(): WalletLinkStore {
    return {
      walletOf: async (subscriberId: string): Promise<Address | null> => {
        const row = this.db
          .prepare('SELECT address FROM wallet_links WHERE subscriber_id = ?')
          .get(subscriberId) as { address: string } | undefined
        return row ? getAddress(row.address as Address) : null
      },
    }
  }

  /** Issue (or reissue) the nonce a subscriber must sign to link a wallet. */
  issueLinkNonce(subscriberId: string, nonce: string): string {
    this.db
      .prepare(
        `INSERT INTO link_nonces (subscriber_id, nonce, issued_at) VALUES (?, ?, ?)
         ON CONFLICT(subscriber_id) DO UPDATE SET nonce = excluded.nonce, issued_at = excluded.issued_at`,
      )
      .run(subscriberId, nonce, this.clock())
    return nonce
  }

  /** The outstanding link nonce for a subscriber, or `null`. */
  getLinkNonce(subscriberId: string): string | null {
    const row = this.db
      .prepare('SELECT nonce FROM link_nonces WHERE subscriber_id = ?')
      .get(subscriberId) as { nonce: string } | undefined
    return row?.nonce ?? null
  }

  /** Consume a link nonce so a signature cannot be replayed. */
  clearLinkNonce(subscriberId: string): void {
    this.db.prepare('DELETE FROM link_nonces WHERE subscriber_id = ?').run(subscriberId)
  }

  // ---- meta and metrics --------------------------------------------------

  /** Read a free-form service setting. */
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  /** Write a free-form service setting. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /** Aggregate counters for `/metrics`. */
  metrics(): StoreMetrics {
    const outbox: Record<OutboxStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0 }
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status')
      .all() as Array<{ status: OutboxStatus; n: number }>
    for (const row of statusRows) outbox[row.status] = Number(row.n)

    const subs = this.db
      .prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM subscriptions')
      .get() as { total: number; enabled: number | null }
    const pools = this.db.prepare('SELECT COUNT(*) AS n FROM pools').get() as { n: number }
    const deliveries = this.db
      .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE at >= ?')
      .get(this.clock() - 3_600_000) as { n: number }

    return {
      subscriptions: Number(subs.total),
      enabledSubscriptions: Number(subs.enabled ?? 0),
      outbox,
      pools: Number(pools.n),
      deliveriesLastHour: Number(deliveries.n),
      cursors: this.listCursors(),
    }
  }

  /** Close the database. Safe to call twice. */
  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}
