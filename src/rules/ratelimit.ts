import type { RateLimitConfig } from './schema.js'

/**
 * Rate limiting is a *storage* question, not an in-memory counter question:
 * a service that resets its limits on every deploy is not rate limited. The
 * engine talks to this interface, the service backs it with the same SQLite
 * file that holds the delivery log, and tests back it with a map.
 */
export interface RateLimitStore {
  /** How many deliveries were recorded for `key` at or after `sinceMs`. */
  countSince(key: string, sinceMs: number): Promise<number>
  /** When `key` last delivered, or `null` if never. */
  lastAt(key: string): Promise<number | null>
  /**
   * Record a delivery against both its rule bucket and its subscriber. The
   * subscriber attribution is what the tier throughput cap counts, so the two
   * are written together and can never drift apart.
   */
  record(key: string, subscriberId: string, atMs: number): Promise<void>
  /** How many alerts a subscriber received since `sinceMs`, for tier caps. */
  countForSubscriberSince(subscriberId: string, sinceMs: number): Promise<number>
}

/** Why a rate limit rejected a delivery, or `null` when it allowed it. */
export interface RateLimitDecision {
  allowed: boolean
  /** Human-readable reason, safe to log and to show in `/status`. */
  reason: string | null
  /** When the next delivery would be allowed, ms since epoch, if known. */
  retryAtMs: number | null
}

const ALLOWED: RateLimitDecision = { allowed: true, reason: null, retryAtMs: null }

/**
 * Check a rule's rate limit without consuming it. Consumption happens through
 * {@link RateLimitStore.record} after a delivery attempt, so a rule that
 * matches but fails entitlement checks does not burn quota.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig | undefined,
  nowMs: number,
): Promise<RateLimitDecision> {
  if (!config) return ALLOWED

  if (config.minIntervalSeconds !== undefined) {
    const last = await store.lastAt(key)
    if (last !== null) {
      const nextAllowed = last + config.minIntervalSeconds * 1000
      if (nowMs < nextAllowed) {
        return {
          allowed: false,
          reason: `minIntervalSeconds=${config.minIntervalSeconds} not elapsed`,
          retryAtMs: nextAllowed,
        }
      }
    }
  }

  if (config.maxPerHour !== undefined) {
    const windowStart = nowMs - 3_600_000
    const used = await store.countSince(key, windowStart)
    if (used >= config.maxPerHour) {
      return {
        allowed: false,
        reason: `maxPerHour=${config.maxPerHour} reached (${used} in the last hour)`,
        retryAtMs: windowStart + 3_600_000,
      }
    }
  }

  return ALLOWED
}

/** An in-memory {@link RateLimitStore}. Correct, but resets with the process. */
export function createMemoryRateLimitStore(): RateLimitStore {
  const byKey = new Map<string, number[]>()
  const bySubscriber = new Map<string, number[]>()

  const push = (map: Map<string, number[]>, id: string, atMs: number): void => {
    const list = map.get(id) ?? []
    list.push(atMs)
    // Keep the window bounded: nothing older than an hour affects a decision.
    map.set(
      id,
      list.filter((at) => at >= atMs - 3_600_000),
    )
  }

  return {
    async countSince(key: string, sinceMs: number): Promise<number> {
      return (byKey.get(key) ?? []).filter((at) => at >= sinceMs).length
    },
    async lastAt(key: string): Promise<number | null> {
      const list = byKey.get(key)
      if (!list || list.length === 0) return null
      return list[list.length - 1] ?? null
    },
    async record(key: string, subscriberId: string, atMs: number): Promise<void> {
      push(byKey, key, atMs)
      push(bySubscriber, subscriberId, atMs)
    },
    async countForSubscriberSince(subscriberId: string, sinceMs: number): Promise<number> {
      return (bySubscriber.get(subscriberId) ?? []).filter((at) => at >= sinceMs).length
    },
  }
}

/** Canonical rate-limit key: one bucket per rule per subscription. */
export function rateLimitKey(subscriptionId: string, ruleId: string): string {
  return `${subscriptionId}:${ruleId}`
}
