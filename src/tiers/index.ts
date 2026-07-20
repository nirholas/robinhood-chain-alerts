/**
 * Tiering and entitlements: what free and premium may do, and who is premium.
 *
 * @packageDocumentation
 */

export {
  TIER_POLICIES,
  canAddRule,
  canAddSubscription,
  isRuleAllowed,
  policyFor,
} from './policy.js'
export type { PolicyDecision, Tier, TierPolicy } from './policy.js'

export {
  accrueExpiry,
  chainEntitlementProviders,
  createStaticEntitlementProvider,
  createUsdgEntitlementProvider,
  linkMessage,
  verifyWalletLink,
} from './entitlements.js'
export type {
  Entitlement,
  EntitlementProvider,
  UsdgEntitlementOptions,
  WalletLinkStore,
} from './entitlements.js'

export { createEntitlementGate } from './enforce.js'
export type { EntitlementGate, EntitlementGateOptions } from './enforce.js'
