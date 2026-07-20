import { z } from 'zod'
import { LAUNCHPAD_EVENT_KINDS, type AlertEventKind, type Launchpad } from '../events/types.js'

/**
 * Rules are data, not code.
 *
 * Every filter a subscriber can set is expressed as a JSON document validated
 * by these schemas, which means a rule can be stored in SQLite, edited from a
 * Telegram or Discord command, diffed, exported and re-imported without any
 * of it going through `eval`, a DSL parser or a hand-rolled validator. The
 * schema is the single source of truth for what a valid rule is: the bot, the
 * service and the tier policy all validate through it.
 */

const addressPattern = /^0x[0-9a-fA-F]{40}$/

/** An EVM address, stored lowercase so comparisons never depend on checksum casing. */
export const addressSchema = z
  .string()
  .regex(addressPattern, 'must be a 0x-prefixed 20-byte address')
  .transform((value) => value.toLowerCase())

/** The four alert kinds. */
export const eventKindSchema = z.enum(['launch', 'curve_trade', 'graduation', 'whale_trade'])

/** The two launchpads. */
export const launchpadSchema = z.enum(['noxa', 'odyssey'])

/** Trade direction filter. `any` disables the filter. */
export const sideSchema = z.enum(['buy', 'sell', 'any'])

/**
 * Deployer reputation filters, all derived from on-chain history (see
 * `hood-alerts/rules` `createRpcReputationProvider`). Every bound is inclusive.
 */
export const reputationFilterSchema = z
  .object({
    /** Require the deployer to have launched at least this many tokens before. */
    minPriorLaunches: z.number().int().min(0).max(10_000).optional(),
    /** Reject serial deployers above this prior-launch count. */
    maxPriorLaunches: z.number().int().min(0).max(10_000).optional(),
    /**
     * Reject a deployer with more than this many prior launches whose pool
     * liquidity has since been drained below the rug threshold.
     */
    maxRuggedLaunches: z.number().int().min(0).max(10_000).optional(),
    /**
     * Require this launch's own LP position to be held by the launchpad's
     * locker contract. Only meaningful for `launch` events that carry a pool
     * (NOXA); events without a pool never satisfy it.
     */
    requireLpLocked: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minPriorLaunches === undefined ||
      value.maxPriorLaunches === undefined ||
      value.minPriorLaunches <= value.maxPriorLaunches,
    { message: 'minPriorLaunches must not exceed maxPriorLaunches' },
  )

/** Per-rule delivery rate limits. */
export const rateLimitSchema = z
  .object({
    /** Hard cap on alerts this rule may deliver per rolling hour. */
    maxPerHour: z.number().int().min(1).max(10_000).optional(),
    /** Minimum gap between two alerts from this rule, in seconds. */
    minIntervalSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict()

/** A single alert rule. */
export const ruleSchema = z
  .object({
    /** Stable id, unique within a subscription. Used in bot commands. */
    id: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters, digits, hyphen or underscore'),
    /** Human label shown in `/rules`. */
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().default(true),
    /** Event kinds this rule reacts to. Defaults to all four. */
    kinds: z.array(eventKindSchema).min(1).max(4).default(['launch', 'curve_trade', 'graduation', 'whale_trade']),
    /** Launchpads this rule reacts to. Defaults to both. */
    launchpads: z.array(launchpadSchema).min(1).max(2).default(['noxa', 'odyssey']),
    /** Minimum USD value of the event. Events with an unknown value never pass. */
    minUsd: z.number().min(0).max(1e12).optional(),
    /** Maximum USD value of the event. */
    maxUsd: z.number().min(0).max(1e12).optional(),
    /** Minimum USD liquidity of the token's deepest known pool. */
    minLiquidityUsd: z.number().min(0).max(1e12).optional(),
    /** Maximum USD liquidity of the token's deepest known pool. */
    maxLiquidityUsd: z.number().min(0).max(1e12).optional(),
    /** Watchlist. When non-empty, only these tokens match. */
    tokens: z.array(addressSchema).max(500).default([]),
    /** Deployer watchlist. When non-empty, only these actors match. */
    deployers: z.array(addressSchema).max(500).default([]),
    /** Deployers to always reject, applied after every other filter. */
    excludeDeployers: z.array(addressSchema).max(500).default([]),
    /** Trade direction. Ignored by `launch` and `graduation` events. */
    side: sideSchema.default('any'),
    reputation: reputationFilterSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
  })
  .strict()
  .refine((rule) => rule.minUsd === undefined || rule.maxUsd === undefined || rule.minUsd <= rule.maxUsd, {
    message: 'minUsd must not exceed maxUsd',
    path: ['minUsd'],
  })
  .refine(
    (rule) =>
      rule.minLiquidityUsd === undefined ||
      rule.maxLiquidityUsd === undefined ||
      rule.minLiquidityUsd <= rule.maxLiquidityUsd,
    { message: 'minLiquidityUsd must not exceed maxLiquidityUsd', path: ['minLiquidityUsd'] },
  )
  .refine((rule) => rule.kinds.some((kind) => rule.launchpads.some((pad) => canEmit(pad, kind))), {
    message:
      'this combination can never fire: NOXA is an instant launcher with no bonding curve, so it emits no curve_trade and no graduation',
    path: ['kinds'],
  })

/** A validated rule. */
export type Rule = z.output<typeof ruleSchema>
/** A rule as accepted on input, before defaults are applied. */
export type RuleInput = z.input<typeof ruleSchema>
/** Validated reputation filter. */
export type ReputationFilter = z.output<typeof reputationFilterSchema>
/** Validated rate limit block. */
export type RateLimitConfig = z.output<typeof rateLimitSchema>

/** Delivery platforms a subscription can target. */
export const platformSchema = z.enum(['telegram', 'discord'])
/** A delivery platform. */
export type Platform = z.output<typeof platformSchema>

/** A subscription: one delivery target plus the rules that feed it. */
export const subscriptionSchema = z
  .object({
    id: z.string().min(1).max(64),
    /**
     * The account that owns this subscription, and the unit entitlements are
     * checked against. For Telegram this is the user id, for Discord the guild
     * id (a server pays once for its channels) or user id for a DM.
     */
    subscriberId: z.string().min(1).max(128),
    platform: platformSchema,
    /**
     * Where alerts go: a Telegram chat id, a Discord channel id, or a Discord
     * webhook URL. Validated per platform by the notifier, not here, because
     * the same subscription record serves all three shapes.
     */
    target: z.string().min(1).max(512),
    enabled: z.boolean().default(true),
    rules: z.array(ruleSchema).max(100).default([]),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine((sub) => new Set(sub.rules.map((rule) => rule.id)).size === sub.rules.length, {
    message: 'rule ids must be unique within a subscription',
    path: ['rules'],
  })

/** A validated subscription. */
export type Subscription = z.output<typeof subscriptionSchema>
/** A subscription as accepted on input. */
export type SubscriptionInput = z.input<typeof subscriptionSchema>

/** Can a launchpad emit this event kind at all? */
export function canEmit(launchpad: Launchpad, kind: AlertEventKind): boolean {
  return LAUNCHPAD_EVENT_KINDS[launchpad].includes(kind)
}

/**
 * How many filters a rule actually uses. The tier policy caps this so free
 * subscribers get real filtering without turning the service into an unpaid
 * on-chain query engine.
 */
export function ruleComplexity(rule: Rule): number {
  let score = 0
  if (rule.minUsd !== undefined) score += 1
  if (rule.maxUsd !== undefined) score += 1
  if (rule.minLiquidityUsd !== undefined) score += 1
  if (rule.maxLiquidityUsd !== undefined) score += 1
  if (rule.tokens.length > 0) score += 1
  if (rule.deployers.length > 0) score += 1
  if (rule.excludeDeployers.length > 0) score += 1
  if (rule.side !== 'any') score += 1
  if (rule.reputation) score += Object.values(rule.reputation).filter((v) => v !== undefined).length
  if (rule.rateLimit) score += 1
  return score
}

/** Filters that cost an extra on-chain read per candidate event. */
export function usesOnChainLookups(rule: Rule): boolean {
  return (
    rule.minLiquidityUsd !== undefined ||
    rule.maxLiquidityUsd !== undefined ||
    (rule.reputation !== undefined &&
      Object.values(rule.reputation).some((value) => value !== undefined))
  )
}

/**
 * Parse and validate a rule, applying defaults.
 *
 * @throws {@link z.ZodError} with a field-level message the bot renders back
 * to the user verbatim.
 *
 * @example
 * ```ts
 * const rule = parseRule({ id: 'whales', kinds: ['whale_trade'], minUsd: 5000 })
 * console.log(rule.launchpads) // ['noxa', 'odyssey'] (defaulted)
 * ```
 */
export function parseRule(input: unknown): Rule {
  return ruleSchema.parse(input)
}

/** Non-throwing {@link parseRule}. */
export function safeParseRule(input: unknown): z.ZodSafeParseResult<Rule> {
  return ruleSchema.safeParse(input)
}

/** Parse and validate a subscription. */
export function parseSubscription(input: unknown): Subscription {
  return subscriptionSchema.parse(input)
}

/** Non-throwing {@link parseSubscription}. */
export function safeParseSubscription(input: unknown): z.ZodSafeParseResult<Subscription> {
  return subscriptionSchema.safeParse(input)
}

/**
 * Render a Zod error as one line of human-readable text, for bot replies.
 * A user who typed `/threshold abc` gets "minUsd: expected number", not a
 * stack trace and not a silent failure.
 */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}

/** A ready-to-use starter rule set, used by `/subscribe` before any editing. */
export function defaultRules(): Rule[] {
  return [
    parseRule({ id: 'launches', name: 'New launches', kinds: ['launch'] }),
    parseRule({
      id: 'graduations',
      name: 'Odyssey graduations',
      kinds: ['graduation'],
      launchpads: ['odyssey'],
    }),
    parseRule({ id: 'whales', name: 'Whale trades over $5k', kinds: ['whale_trade'], minUsd: 5000 }),
  ]
}
