import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decode, decodeEvent, encode, encodeEvent } from '../src/service/codec.js'
import { AlertStore } from '../src/service/store.js'
import { parseRule, parseSubscription } from '../src/rules/schema.js'
import { addr, fakeClock, launchEvent } from './helpers.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function onDisk(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hood-alerts-test-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'state.sqlite')
}

function subscription(overrides: Record<string, unknown> = {}) {
  return parseSubscription({
    id: 'sub-1',
    subscriberId: 'telegram:1',
    platform: 'telegram',
    target: '123',
    rules: [parseRule({ id: 'launches', kinds: ['launch'], tokens: [addr(4)] })],
    createdAtMs: 0,
    ...overrides,
  })
}

function outboxRow(id: string, notBeforeMs = 0) {
  return {
    id,
    subscriptionId: 'sub-1',
    subscriberId: 'telegram:1',
    ruleId: 'launches',
    eventId: id,
    eventJson: encodeEvent(launchEvent()),
    platform: 'telegram' as const,
    target: '123',
    notBeforeMs,
  }
}

describe('codec', () => {
  it('round-trips bigints exactly, including values beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n
    const restored = decode<{ value: bigint }>(encode({ value: huge }))
    expect(restored.value).toBe(huge)
  })

  it('round-trips a whole event', () => {
    const event = launchEvent({ block: 987_654_321n })
    const restored = decodeEvent(encodeEvent(event))
    expect(restored).toEqual(event)
    expect(typeof restored.blockNumber).toBe('bigint')
  })

  it('leaves ordinary values alone', () => {
    expect(decode(encode({ a: 1, b: 'x', c: null, d: [1, 2] }))).toEqual({ a: 1, b: 'x', c: null, d: [1, 2] })
  })
})

describe('store persistence', () => {
  it('creates missing directories for the database file', () => {
    const path = onDisk()
    const store = new AlertStore(path)
    store.setCursor('s', 1n)
    store.close()

    const reopened = new AlertStore(path)
    expect(reopened.getCursor('s')).toBe(1n)
    reopened.close()
  })

  it('round-trips a subscription through SQLite', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    const loaded = store.getSubscription('sub-1')

    expect(loaded?.subscriberId).toBe('telegram:1')
    expect(loaded?.rules[0]?.tokens).toEqual([addr(4).toLowerCase()])
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(1)
    expect(store.listEnabledSubscriptions()).toHaveLength(1)
    store.close()
  })

  it('updates a subscription in place rather than duplicating it', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    store.saveSubscription(subscription({ target: '999' }))
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(1)
    expect(store.getSubscription('sub-1')?.target).toBe('999')
    store.close()
  })

  it('excludes disabled subscriptions from the dispatch fan-out', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription({ enabled: false }))
    expect(store.listEnabledSubscriptions()).toHaveLength(0)
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(1)
    store.close()
  })

  it('collects watchlist tokens across subscriptions for the whale pool set', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    store.saveSubscription(
      subscription({
        id: 'sub-2',
        subscriberId: 'telegram:2',
        rules: [parseRule({ id: 'r', kinds: ['launch'], tokens: [addr(4), addr(5)] })],
      }),
    )
    expect(store.watchlistTokens().sort()).toEqual([addr(4), addr(5)].sort())
    store.close()
  })

  it('deletes a subscription and reports whether anything was removed', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    expect(store.deleteSubscription('sub-1')).toBe(true)
    expect(store.deleteSubscription('sub-1')).toBe(false)
    store.close()
  })
})

describe('outbox', () => {
  it('reports a duplicate enqueue instead of inserting twice', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    expect(store.enqueue(outboxRow('a'))).toBe(true)
    expect(store.enqueue(outboxRow('a'))).toBe(false)
    expect(store.metrics().outbox.pending).toBe(1)
    store.close()
  })

  it('claims only rows that are due', () => {
    const clock = fakeClock(1_000)
    const store = new AlertStore(':memory:', clock.now)
    store.saveSubscription(subscription())
    store.enqueue(outboxRow('now', 1_000))
    store.enqueue(outboxRow('later', 10_000))

    const claimed = store.claimDue(clock.now(), 10)
    expect(claimed.map((row) => row.id)).toEqual(['now'])
    expect(store.metrics().outbox.sending).toBe(1)
    expect(store.metrics().outbox.pending).toBe(1)
    store.close()
  })

  it('does not hand the same row to two claim passes', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    store.enqueue(outboxRow('a'))
    expect(store.claimDue(1, 10)).toHaveLength(1)
    expect(store.claimDue(1, 10)).toHaveLength(0)
    store.close()
  })

  it('respects the claim batch limit', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    for (let i = 0; i < 5; i += 1) store.enqueue(outboxRow(`row-${i}`))
    expect(store.claimDue(1, 2)).toHaveLength(2)
    store.close()
  })

  it('moves rows through sent, failed and dead', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    store.enqueue(outboxRow('sent'))
    store.enqueue(outboxRow('failed'))
    store.enqueue(outboxRow('dead'))
    store.claimDue(1, 10)

    store.markSent('sent')
    store.markFailed('failed', 1, 'boom', 5_000)
    store.markDead('dead', 3, 'gone')

    const metrics = store.metrics().outbox
    expect(metrics.sent).toBe(1)
    expect(metrics.failed).toBe(1)
    expect(metrics.dead).toBe(1)

    // A failed row is retried once its backoff elapses, a dead one never is.
    expect(store.claimDue(4_999, 10)).toHaveLength(0)
    expect(store.claimDue(5_000, 10).map((row) => row.id)).toEqual(['failed'])
    store.close()
  })

  it('recovers rows abandoned mid-flight', () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscription())
    store.enqueue(outboxRow('a'))
    store.claimDue(1, 10)
    expect(store.recoverInFlight()).toBe(1)
    expect(store.metrics().outbox.pending).toBe(1)
    expect(store.recoverInFlight()).toBe(0)
    store.close()
  })

  it('prunes delivered rows and old delivery history only', () => {
    const clock = fakeClock(100_000)
    const store = new AlertStore(':memory:', clock.now)
    store.saveSubscription(subscription())
    store.enqueue(outboxRow('sent'))
    store.enqueue(outboxRow('kept'))
    store.claimDue(clock.now(), 10)
    store.markSent('sent')
    store.recordDelivery('k', 'telegram:1', 1_000)
    store.recordDelivery('k', 'telegram:1', 99_000)

    expect(store.pruneOutbox(clock.now() + 1)).toBe(1)
    expect(store.metrics().outbox.sending).toBe(1)
    expect(store.pruneDeliveries(50_000)).toBe(1)
    expect(store.countDeliveriesForSubscriber('telegram:1', 0)).toBe(1)
    store.close()
  })
})

describe('rate-limit store backed by SQLite', () => {
  it('counts per bucket and per subscriber', async () => {
    const store = new AlertStore(':memory:')
    const limits = store.rateLimitStore()
    await limits.record('sub:rule-a', 'telegram:1', 1_000)
    await limits.record('sub:rule-b', 'telegram:1', 2_000)

    expect(await limits.countSince('sub:rule-a', 0)).toBe(1)
    expect(await limits.lastAt('sub:rule-b')).toBe(2_000)
    expect(await limits.lastAt('sub:rule-c')).toBeNull()
    expect(await limits.countForSubscriberSince('telegram:1', 0)).toBe(2)
    expect(await limits.countForSubscriberSince('telegram:1', 1_500)).toBe(1)
    store.close()
  })
})

describe('pool registry backed by SQLite', () => {
  it('records pools, resolves origins and returns the newest first', async () => {
    const store = new AlertStore(':memory:')
    const registry = store.poolRegistry()
    await registry.record({
      pool: addr(10),
      token: addr(1),
      quoteToken: addr(99),
      launchpad: 'noxa',
      createdBlock: 100n,
    })
    await registry.record({
      pool: addr(11),
      token: addr(2),
      quoteToken: addr(99),
      launchpad: 'odyssey',
      createdBlock: 12_000_000n,
    })

    expect(await registry.size()).toBe(2)
    expect(await registry.originOf(addr(1))).toBe('noxa')
    expect(await registry.originOf(addr(3))).toBeNull()
    expect((await registry.poolsFor(addr(2)))[0]?.launchpad).toBe('odyssey')

    // Ordering is numeric on a text column, so a 12-million block still beats
    // a 100 block.
    const active = await registry.active(1)
    expect(active.map((entry) => entry.pool)).toEqual([addr(11)])

    // A pinned watchlist token is included regardless of age.
    const pinned = await registry.active(1, [addr(1)])
    expect(pinned.map((entry) => entry.pool).sort()).toEqual([addr(10), addr(11)].sort())
    store.close()
  })

  it('updates a pool in place on a repeated record', async () => {
    const store = new AlertStore(':memory:')
    const registry = store.poolRegistry()
    const entry = {
      pool: addr(10),
      token: addr(1),
      quoteToken: addr(99),
      launchpad: 'noxa' as const,
      createdBlock: 100n,
    }
    await registry.record(entry)
    await registry.record({ ...entry, createdBlock: 200n })
    expect(await registry.size()).toBe(1)
    expect((await registry.poolsFor(addr(1)))[0]?.createdBlock).toBe(200n)
    store.close()
  })
})

describe('wallet links and meta', () => {
  it('stores a link and issues then consumes a nonce', async () => {
    const store = new AlertStore(':memory:')
    expect(await store.walletLinks().walletOf('telegram:1')).toBeNull()

    store.issueLinkNonce('telegram:1', 'nonce-1')
    expect(store.getLinkNonce('telegram:1')).toBe('nonce-1')
    store.issueLinkNonce('telegram:1', 'nonce-2')
    expect(store.getLinkNonce('telegram:1')).toBe('nonce-2')

    store.linkWallet('telegram:1', addr(7))
    expect(await store.walletLinks().walletOf('telegram:1')).toBe(addr(7))

    store.clearLinkNonce('telegram:1')
    expect(store.getLinkNonce('telegram:1')).toBeNull()
    store.close()
  })

  it('stores free-form settings such as the Telegram update offset', () => {
    const store = new AlertStore(':memory:')
    expect(store.getMeta('telegram:offset')).toBeNull()
    store.setMeta('telegram:offset', '42')
    store.setMeta('telegram:offset', '43')
    expect(store.getMeta('telegram:offset')).toBe('43')
    store.close()
  })

  it('closes idempotently', () => {
    const store = new AlertStore(':memory:')
    store.close()
    expect(() => store.close()).not.toThrow()
  })
})
