import type { Rule } from '../rules/schema.js'
import type { Entitlement, EntitlementProvider } from './entitlements.js'
import {
  canAddRule,
  canAddSubscription,
  isRuleAllowed,
  policyFor,
  type PolicyDecision,
  type Tier,
  type TierPolicy,
} from './policy.js'

/**
 * The entitlement chokepoint.
 *
 * Every tier question in the codebase goes through this object: the bot asks
 * it before accepting a subscription or a rule, and the dispatcher asks it
 * before queuing a delivery. Nothing else reads {@link TIER_POLICIES}
 * directly. One place to audit, one place to change the commercial model, no
 * chance of the bot and the dispatcher disagreeing about who is premium.
 */
export interface EntitlementGate {
  /** Resolve tier, policy and expiry for a subscriber. */
  resolve(subscriberId: string): Promise<{ entitlement: Entitlement; policy: TierPolicy }>
  /** May they add another subscription? */
  checkAddSubscription(subscriberId: string, currentCount: number): Promise<PolicyDecision>
  /** May they add this rule to a subscription with `currentRuleCount` rules? */
  checkAddRule(subscriberId: string, rule: Rule, currentRuleCount: number): Promise<PolicyDecision>
  /** Is this rule within their tier, ignoring counts (used when editing)? */
  checkRule(subscriberId: string, rule: Rule): Promise<PolicyDecision>
  /** How long a delivery for this subscriber is held before sending, in ms. */
  deliveryDelayMs(subscriberId: string): Promise<number>
  /** Have they exhausted their hourly delivery budget? */
  checkThroughput(subscriberId: string, deliveredInLastHour: number): Promise<PolicyDecision>
}

/** Options for {@link createEntitlementGate}. */
export interface EntitlementGateOptions {
  provider: EntitlementProvider
  /** Per-deployment overrides of the shipped tier table. */
  policyOverrides?: Partial<Record<Tier, Partial<TierPolicy>>>
}

/** Build the gate. */
export function createEntitlementGate(options: EntitlementGateOptions): EntitlementGate {
  async function resolve(
    subscriberId: string,
  ): Promise<{ entitlement: Entitlement; policy: TierPolicy }> {
    const entitlement = await options.provider.get(subscriberId)
    return { entitlement, policy: policyFor(entitlement.tier, options.policyOverrides) }
  }

  return {
    resolve,
    async checkAddSubscription(subscriberId: string, currentCount: number): Promise<PolicyDecision> {
      const { policy } = await resolve(subscriberId)
      return canAddSubscription(policy, currentCount)
    },
    async checkAddRule(
      subscriberId: string,
      rule: Rule,
      currentRuleCount: number,
    ): Promise<PolicyDecision> {
      const { policy } = await resolve(subscriberId)
      return canAddRule(policy, rule, currentRuleCount)
    },
    async checkRule(subscriberId: string, rule: Rule): Promise<PolicyDecision> {
      const { policy } = await resolve(subscriberId)
      return isRuleAllowed(policy, rule)
    },
    async deliveryDelayMs(subscriberId: string): Promise<number> {
      const { policy } = await resolve(subscriberId)
      return policy.deliveryDelayMs
    },
    async checkThroughput(
      subscriberId: string,
      deliveredInLastHour: number,
    ): Promise<PolicyDecision> {
      const { policy } = await resolve(subscriberId)
      if (deliveredInLastHour >= policy.maxAlertsPerHour) {
        return {
          allowed: false,
          reason: `hourly alert cap reached (${policy.maxAlertsPerHour} on the ${policy.tier} tier)`,
        }
      }
      return { allowed: true, reason: null }
    },
  }
}
