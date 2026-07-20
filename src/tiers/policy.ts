import type { AlertEventKind } from '../events/types.js'
import { ruleComplexity, usesOnChainLookups, type Rule } from '../rules/schema.js'

/**
 * Tiering, as an enforced policy layer rather than a marketing page.
 *
 * Every limit here exists because it maps to a real cost the service pays:
 *
 * - `maxSubscriptions` / `maxRulesPerSubscription` bound the per-event fan-out.
 * - `maxRuleComplexity` bounds how much work one rule can ask for.
 * - `allowOnChainLookupFilters` gates the filters that cost an RPC read per
 *   candidate event (liquidity, deployer reputation). This is the expensive
 *   one, so it is the clearest free/premium line.
 * - `maxAlertsPerHour` bounds delivery throughput.
 * - `deliveryDelayMs` is the latency difference. Free alerts are held briefly;
 *   premium alerts go out as soon as the block is confirmed. It is enforced in
 *   the outbox (the delivery row carries `not_before`), so it survives a
 *   restart instead of being a `setTimeout` that a crash erases.
 * - `allowedKinds` keeps the highest-volume stream (every bonding-curve trade)
 *   on the paid tier, because it is a firehose, not an alert.
 */

/** The two tiers. */
export type Tier = 'free' | 'premium'

/** What a tier is allowed to do. */
export interface TierPolicy {
  tier: Tier
  /** Max delivery targets one subscriber may have. */
  maxSubscriptions: number
  /** Max rules per subscription. */
  maxRulesPerSubscription: number
  /** Max {@link ruleComplexity} score for a single rule. */
  maxRuleComplexity: number
  /** Max entries in a rule's token or deployer watchlist. */
  maxWatchlistTokens: number
  /** Max alerts delivered per subscriber per rolling hour. */
  maxAlertsPerHour: number
  /** How long alerts are held before delivery, in ms. */
  deliveryDelayMs: number
  /** May rules use liquidity and reputation filters (each costs an RPC read). */
  allowOnChainLookupFilters: boolean
  /** Event kinds this tier may subscribe to. */
  allowedKinds: readonly AlertEventKind[]
}

/** The shipped policy table. Override per deployment through the service config. */
export const TIER_POLICIES: Record<Tier, TierPolicy> = {
  free: {
    tier: 'free',
    maxSubscriptions: 1,
    maxRulesPerSubscription: 3,
    maxRuleComplexity: 3,
    maxWatchlistTokens: 5,
    maxAlertsPerHour: 30,
    deliveryDelayMs: 60_000,
    allowOnChainLookupFilters: false,
    allowedKinds: ['launch', 'graduation', 'whale_trade'],
  },
  premium: {
    tier: 'premium',
    maxSubscriptions: 10,
    maxRulesPerSubscription: 50,
    maxRuleComplexity: 24,
    maxWatchlistTokens: 500,
    maxAlertsPerHour: 2_000,
    deliveryDelayMs: 0,
    allowOnChainLookupFilters: true,
    allowedKinds: ['launch', 'curve_trade', 'graduation', 'whale_trade'],
  },
}

/** A policy decision. `allowed: false` always carries a user-facing reason. */
export interface PolicyDecision {
  allowed: boolean
  /** Present when `allowed` is false. Written to be shown to the subscriber. */
  reason: string | null
}

const OK: PolicyDecision = { allowed: true, reason: null }
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason })

/** May this subscriber add another subscription? */
export function canAddSubscription(policy: TierPolicy, currentCount: number): PolicyDecision {
  if (currentCount >= policy.maxSubscriptions) {
    return deny(
      `the ${policy.tier} tier allows ${policy.maxSubscriptions} subscription${
        policy.maxSubscriptions === 1 ? '' : 's'
      } and you have ${currentCount}. Upgrade with /upgrade, or remove one with /unsubscribe.`,
    )
  }
  return OK
}

/** May this rule be added to a subscription that already has `currentRuleCount` rules? */
export function canAddRule(
  policy: TierPolicy,
  rule: Rule,
  currentRuleCount: number,
): PolicyDecision {
  if (currentRuleCount >= policy.maxRulesPerSubscription) {
    return deny(
      `the ${policy.tier} tier allows ${policy.maxRulesPerSubscription} rules per subscription and you have ${currentRuleCount}.`,
    )
  }
  return isRuleAllowed(policy, rule)
}

/** Is this rule within the tier's limits, regardless of how many exist? */
export function isRuleAllowed(policy: TierPolicy, rule: Rule): PolicyDecision {
  const disallowedKinds = rule.kinds.filter((kind) => !policy.allowedKinds.includes(kind))
  if (disallowedKinds.length > 0) {
    return deny(
      `the ${policy.tier} tier does not include ${disallowedKinds.join(', ')} alerts. Allowed: ${policy.allowedKinds.join(', ')}.`,
    )
  }
  const complexity = ruleComplexity(rule)
  if (complexity > policy.maxRuleComplexity) {
    return deny(
      `this rule uses ${complexity} filters and the ${policy.tier} tier allows ${policy.maxRuleComplexity}.`,
    )
  }
  if (rule.tokens.length > policy.maxWatchlistTokens) {
    return deny(
      `the ${policy.tier} tier allows ${policy.maxWatchlistTokens} watchlist tokens and this rule has ${rule.tokens.length}.`,
    )
  }
  if (rule.deployers.length + rule.excludeDeployers.length > policy.maxWatchlistTokens) {
    return deny(
      `the ${policy.tier} tier allows ${policy.maxWatchlistTokens} watched deployers per rule.`,
    )
  }
  if (!policy.allowOnChainLookupFilters && usesOnChainLookups(rule)) {
    return deny(
      `liquidity and deployer-reputation filters are a premium feature: each one costs an on-chain read per candidate event.`,
    )
  }
  return OK
}

/** Resolve the policy for a tier. */
export function policyFor(tier: Tier, overrides?: Partial<Record<Tier, Partial<TierPolicy>>>): TierPolicy {
  const base = TIER_POLICIES[tier]
  const override = overrides?.[tier]
  return override ? { ...base, ...override, tier } : base
}
