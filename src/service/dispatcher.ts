import type { EventSource } from '../events/sources.js'
import type { AlertEvent } from '../events/types.js'
import { matchRules, type EvaluationContext } from '../rules/engine.js'
import { checkRateLimit, rateLimitKey, type RateLimitStore } from '../rules/ratelimit.js'
import type { Subscription } from '../rules/schema.js'
import { renderAlert, type RenderOptions } from '../notifiers/format.js'
import type { Notifier } from '../notifiers/types.js'
import type { EntitlementGate } from '../tiers/enforce.js'
import { decodeEvent, encodeEvent } from './codec.js'
import type { Logger } from './logger.js'
import { AlertStore, type OutboxRow } from './store.js'

/**
 * The dispatcher: chain to inbox, in two independent halves.
 *
 * **`pollOnce`** reads confirmed block ranges, fans events out across
 * subscriptions and rules, and writes matched deliveries into the outbox. It
 * advances a source's cursor only after every event in the range has been
 * enqueued and committed, which is the property that makes a crash safe:
 * re-reading a range regenerates identical delivery ids and inserts nothing.
 *
 * **`flushOnce`** drains the outbox: claim due rows, render, send, mark the
 * outcome, retry retryable failures with backoff, dead-letter permanent ones.
 *
 * Splitting them is what lets the free tier have a real delivery delay (the
 * row carries `not_before`), lets a Telegram outage stall delivery without
 * stalling ingestion, and keeps a slow platform from pushing the block cursor
 * behind the chain.
 */

/** What one `pollOnce` did. */
export interface PollStats {
  /** Blocks covered per source. */
  ranges: { sourceId: string; from: bigint; to: bigint }[]
  eventsDecoded: number
  /** Deliveries newly written to the outbox. */
  enqueued: number
  /** Matches that were already in the outbox (a replayed range). */
  deduped: number
  /** Matches suppressed by a rule rate limit or a tier throughput cap. */
  suppressed: number
  /** Sources that failed this pass. Their cursors did not advance. */
  errors: { sourceId: string; error: string }[]
}

/** What one `flushOnce` did. */
export interface FlushStats {
  claimed: number
  sent: number
  retried: number
  dead: number
}

/** Options for {@link createDispatcher}. */
export interface DispatcherOptions {
  store: AlertStore
  sources: readonly EventSource[]
  gate: EntitlementGate
  rateLimits: RateLimitStore
  /** Resolve the adapter for a subscription. */
  notifierFor: (subscription: Subscription) => Notifier | null
  /** Head block source. */
  getBlockNumber: () => Promise<bigint>
  logger: Logger
  /** Lazy lookups for liquidity and reputation filters. */
  evaluation?: EvaluationContext
  /** Telegram parse mode and footer options. */
  render?: RenderOptions
  /** Confirmations before a block is processed. @defaultValue `2n` */
  confirmations?: bigint
  /** Max blocks per poll per source. @defaultValue `2_000n` */
  chunkSize?: bigint
  /**
   * Where a source starts when it has no persisted cursor: this many blocks
   * behind the head. A fresh deployment should not replay months of history
   * into a subscriber's chat. @defaultValue `5_000n`
   */
  initialLookbackBlocks?: bigint
  /** Max outbox rows drained per flush. @defaultValue `50` */
  flushBatchSize?: number
  /** Attempts before a delivery is dead-lettered. @defaultValue `6` */
  maxDeliveryAttempts?: number
  /** Base retry backoff in ms, doubled per attempt. @defaultValue `30_000` */
  retryBackoffMs?: number
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

/** The dispatcher. */
export interface Dispatcher {
  /** Ingest one confirmed range per source. */
  pollOnce(): Promise<PollStats>
  /** Deliver one batch of due outbox rows. */
  flushOnce(): Promise<FlushStats>
  /** Return rows abandoned by a crash to the queue. Call once at startup. */
  recover(): number
}

/** Build the dispatcher. */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const {
    store,
    sources,
    gate,
    rateLimits,
    notifierFor,
    getBlockNumber,
    logger,
  } = options
  const confirmations = options.confirmations ?? 2n
  const chunkSize = options.chunkSize ?? 2_000n
  const initialLookback = options.initialLookbackBlocks ?? 5_000n
  const flushBatchSize = options.flushBatchSize ?? 50
  const maxAttempts = options.maxDeliveryAttempts ?? 6
  const retryBackoffMs = options.retryBackoffMs ?? 30_000
  const now = options.now ?? Date.now
  const evaluation = options.evaluation ?? {}

  /**
   * Fan one event out to every enabled subscription and write the matches.
   * Returns the counters this event contributed.
   */
  async function fanOut(
    event: AlertEvent,
    subscriptions: readonly Subscription[],
  ): Promise<{ enqueued: number; deduped: number; suppressed: number }> {
    let enqueued = 0
    let deduped = 0
    let suppressed = 0

    for (const subscription of subscriptions) {
      const matches = await matchRules(subscription.rules, event, evaluation)
      if (matches.length === 0) continue

      const { policy } = await gate.resolve(subscription.subscriberId)
      for (const { rule } of matches) {
        // Tier gating happens here rather than at rule-creation time only,
        // because an entitlement can lapse after a rule was accepted.
        if (!policy.allowedKinds.includes(event.kind)) {
          suppressed += 1
          continue
        }

        const key = rateLimitKey(subscription.id, rule.id)
        const limit = await checkRateLimit(rateLimits, key, rule.rateLimit, now())
        if (!limit.allowed) {
          suppressed += 1
          logger.debug('rate limited', { subscription: subscription.id, rule: rule.id, reason: limit.reason })
          continue
        }

        const usedThisHour = await rateLimits.countForSubscriberSince(
          subscription.subscriberId,
          now() - 3_600_000,
        )
        const throughput = await gate.checkThroughput(subscription.subscriberId, usedThisHour)
        if (!throughput.allowed) {
          suppressed += 1
          logger.debug('throughput capped', {
            subscriber: subscription.subscriberId,
            reason: throughput.reason,
          })
          continue
        }

        const id = AlertStore.deliveryKey(event.id, subscription.id, rule.id)
        const created = store.enqueue({
          id,
          subscriptionId: subscription.id,
          subscriberId: subscription.subscriberId,
          ruleId: rule.id,
          eventId: event.id,
          eventJson: encodeEvent(event),
          platform: subscription.platform,
          target: subscription.target,
          notBeforeMs: now() + policy.deliveryDelayMs,
        })
        if (!created) {
          deduped += 1
          continue
        }
        enqueued += 1
        // An enqueued alert is committed to being sent, so it consumes quota
        // now. Counting at send time instead would let one block's worth of
        // events blow straight through every cap before the first delivery.
        await rateLimits.record(key, subscription.subscriberId, now())
      }
    }
    return { enqueued, deduped, suppressed }
  }

  return {
    recover(): number {
      const recovered = store.recoverInFlight()
      if (recovered > 0) logger.warn('recovered in-flight deliveries after restart', { recovered })
      return recovered
    },

    async pollOnce(): Promise<PollStats> {
      const stats: PollStats = {
        ranges: [],
        eventsDecoded: 0,
        enqueued: 0,
        deduped: 0,
        suppressed: 0,
        errors: [],
      }
      const head = await getBlockNumber()
      const safeHead = head > confirmations ? head - confirmations : 0n
      const subscriptions = store.listEnabledSubscriptions()

      for (const source of sources) {
        const persisted = store.getCursor(source.id)
        const fallback = safeHead > initialLookback ? safeHead - initialLookback : source.startBlock
        const from = persisted ?? (fallback > source.startBlock ? fallback : source.startBlock)
        if (from > safeHead) continue
        const to = from + chunkSize - 1n > safeHead ? safeHead : from + chunkSize - 1n

        try {
          const events = await source.poll(from, to)
          stats.eventsDecoded += events.length
          for (const event of events) {
            const result = await fanOut(event, subscriptions)
            stats.enqueued += result.enqueued
            stats.deduped += result.deduped
            stats.suppressed += result.suppressed
          }
          // Committed only after every event in the range is in the outbox.
          store.setCursor(source.id, to + 1n)
          stats.ranges.push({ sourceId: source.id, from, to })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          stats.errors.push({ sourceId: source.id, error: message })
          logger.error('source poll failed, cursor not advanced', {
            source: source.id,
            from,
            to,
            error: message,
          })
        }
      }
      return stats
    },

    async flushOnce(): Promise<FlushStats> {
      const stats: FlushStats = { claimed: 0, sent: 0, retried: 0, dead: 0 }
      const rows = store.claimDue(now(), flushBatchSize)
      stats.claimed = rows.length

      for (const row of rows) {
        const outcome = await deliver(row)
        if (outcome === 'sent') stats.sent += 1
        else if (outcome === 'retry') stats.retried += 1
        else stats.dead += 1
      }
      return stats
    },
  }

  async function deliver(row: OutboxRow): Promise<'sent' | 'retry' | 'dead'> {
    const subscription = store.getSubscription(row.subscriptionId)
    if (!subscription) {
      store.markDead(row.id, row.attempts + 1, 'subscription no longer exists')
      return 'dead'
    }
    const notifier = notifierFor(subscription)
    if (!notifier) {
      store.markDead(row.id, row.attempts + 1, `no notifier configured for platform ${row.platform}`)
      return 'dead'
    }

    let event: AlertEvent
    try {
      event = decodeEvent(row.eventJson)
    } catch (error) {
      // An undecodable row can never succeed. Dead-letter it rather than
      // retrying a corrupt payload forever.
      store.markDead(row.id, row.attempts + 1, `corrupt event payload: ${String(error)}`)
      return 'dead'
    }

    const alert = renderAlert(event, {
      ...options.render,
      footer: options.render?.footer ?? `rule: ${row.ruleId}`,
    })
    const result = await notifier.send(row.target, alert)
    const attempts = row.attempts + 1

    if (result.ok) {
      store.markSent(row.id)
      logger.info('alert delivered', {
        id: row.id,
        platform: notifier.platform,
        kind: event.kind,
        token: event.token,
        attempts: result.attempts,
      })
      return 'sent'
    }

    if (!result.retryable || attempts >= maxAttempts) {
      store.markDead(row.id, attempts, result.error ?? 'delivery failed')
      logger.error('alert dead-lettered', {
        id: row.id,
        platform: notifier.platform,
        attempts,
        retryable: result.retryable,
        error: result.error,
      })
      return 'dead'
    }

    const nextAttemptAt = now() + retryBackoffMs * 2 ** (attempts - 1)
    store.markFailed(row.id, attempts, result.error ?? 'delivery failed', nextAttemptAt)
    logger.warn('alert delivery failed, will retry', {
      id: row.id,
      attempts,
      nextAttemptAt,
      error: result.error,
    })
    return 'retry'
  }
}
