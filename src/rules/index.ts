/**
 * The rule engine: serializable, schema-validated per-subscription filters,
 * evaluated lazily against normalized alert events.
 *
 * @packageDocumentation
 */

export {
  addressSchema,
  canEmit,
  defaultRules,
  eventKindSchema,
  formatValidationError,
  launchpadSchema,
  parseRule,
  parseSubscription,
  platformSchema,
  rateLimitSchema,
  reputationFilterSchema,
  ruleComplexity,
  ruleSchema,
  safeParseRule,
  safeParseSubscription,
  sideSchema,
  subscriptionSchema,
  usesOnChainLookups,
} from './schema.js'
export type {
  Platform,
  RateLimitConfig,
  ReputationFilter,
  Rule,
  RuleInput,
  Subscription,
  SubscriptionInput,
} from './schema.js'

export { evaluateRule, matchRules } from './engine.js'
export type { EvaluationContext, MatchResult } from './engine.js'

export { checkRateLimit, createMemoryRateLimitStore, rateLimitKey } from './ratelimit.js'
export type { RateLimitDecision, RateLimitStore } from './ratelimit.js'

export { createRpcReputationProvider, priorLaunchesBefore } from './reputation.js'
export type {
  DeployerReputation,
  PriorLaunch,
  ReputationProvider,
  ReputationProviderOptions,
} from './reputation.js'
