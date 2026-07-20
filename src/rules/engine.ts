import type { Address } from 'viem'
import type { AlertEvent } from '../events/types.js'
import { priorLaunchesBefore, type DeployerReputation } from './reputation.js'
import type { Rule } from './schema.js'

/**
 * The rule engine: does this event satisfy this rule?
 *
 * Two properties matter more than the filter list itself.
 *
 * **Lazy, ordered evaluation.** Cheap in-memory filters (kind, launchpad,
 * watchlists, USD bounds) run before anything that costs an RPC call
 * (liquidity, reputation). A rule that rejects an event on its kind never
 * triggers a pool balance read. With thousands of subscriptions this is the
 * difference between a service that keeps up with the chain and one that does
 * not.
 *
 * **Unknown is not a pass.** Every USD and liquidity figure can legitimately
 * be `null` (no USDG or WETH leg to price against, an unreadable pool). A
 * filter that asks for a measurement the chain did not give us does not match.
 * The alternative, treating unknown as zero or as infinity, silently satisfies
 * either `minUsd` or `maxLiquidityUsd` and ships alerts that are simply wrong.
 */

/** Lazily-invoked lookups the engine uses only when a rule needs them. */
export interface EvaluationContext {
  /** USD liquidity of the event token's deepest known pool. */
  liquidityUsd?: (event: AlertEvent) => Promise<number | null>
  /** On-chain track record for a deployer. */
  reputation?: (deployer: Address) => Promise<DeployerReputation>
  /** Is this LP position held by the launchpad locker? */
  isLpLocked?: (positionId: bigint) => Promise<boolean>
}

/** The outcome of evaluating one rule against one event. */
export interface MatchResult {
  matched: boolean
  /**
   * Why. On a match this names the rule; on a miss it names the first filter
   * that rejected the event. The bot's `/status` and the service's debug log
   * both surface this, so "why didn't I get an alert" is answerable.
   */
  reason: string
}

const matchOk = (rule: Rule): MatchResult => ({ matched: true, reason: `rule ${rule.id} matched` })
const miss = (reason: string): MatchResult => ({ matched: false, reason })

function eventSide(event: AlertEvent): 'buy' | 'sell' | null {
  if (event.kind === 'curve_trade' || event.kind === 'whale_trade') return event.side
  return null
}

function eventPositionId(event: AlertEvent): bigint | null {
  if (event.kind === 'launch') return event.positionId
  if (event.kind === 'graduation') return event.positionId
  return null
}

/**
 * Evaluate a rule against an event.
 *
 * @example
 * ```ts
 * const rule = parseRule({ id: 'whales', kinds: ['whale_trade'], minUsd: 5000 })
 * const result = await evaluateRule(rule, event)
 * if (!result.matched) console.log('skipped:', result.reason)
 * ```
 */
export async function evaluateRule(
  rule: Rule,
  event: AlertEvent,
  context: EvaluationContext = {},
): Promise<MatchResult> {
  if (!rule.enabled) return miss(`rule ${rule.id} is disabled`)

  if (!rule.kinds.includes(event.kind)) {
    return miss(`kind ${event.kind} not in [${rule.kinds.join(', ')}]`)
  }
  if (!rule.launchpads.includes(event.launchpad)) {
    return miss(`launchpad ${event.launchpad} not in [${rule.launchpads.join(', ')}]`)
  }

  const actor = event.actor.toLowerCase()
  if (rule.excludeDeployers.includes(actor)) {
    return miss(`actor ${event.actor} is on the exclude list`)
  }
  if (rule.tokens.length > 0 && !rule.tokens.includes(event.token.toLowerCase())) {
    return miss(`token ${event.token} is not on the watchlist`)
  }
  if (rule.deployers.length > 0 && !rule.deployers.includes(actor)) {
    return miss(`actor ${event.actor} is not on the deployer watchlist`)
  }

  if (rule.side !== 'any') {
    const side = eventSide(event)
    if (side === null) return miss(`side filter does not apply to ${event.kind} events`)
    if (side !== rule.side) return miss(`side ${side} is not ${rule.side}`)
  }

  if (rule.minUsd !== undefined) {
    if (event.usdValue === null) return miss('event has no USD value to compare against minUsd')
    if (event.usdValue < rule.minUsd) {
      return miss(`usdValue ${event.usdValue.toFixed(2)} below minUsd ${rule.minUsd}`)
    }
  }
  if (rule.maxUsd !== undefined) {
    if (event.usdValue === null) return miss('event has no USD value to compare against maxUsd')
    if (event.usdValue > rule.maxUsd) {
      return miss(`usdValue ${event.usdValue.toFixed(2)} above maxUsd ${rule.maxUsd}`)
    }
  }

  // Everything below costs at least one RPC read.
  if (rule.minLiquidityUsd !== undefined || rule.maxLiquidityUsd !== undefined) {
    if (!context.liquidityUsd) {
      return miss('rule filters on liquidity but no liquidity reader was provided')
    }
    const liquidity = await context.liquidityUsd(event)
    if (liquidity === null) return miss('token liquidity is unknown')
    if (rule.minLiquidityUsd !== undefined && liquidity < rule.minLiquidityUsd) {
      return miss(`liquidity ${liquidity.toFixed(2)} below minLiquidityUsd ${rule.minLiquidityUsd}`)
    }
    if (rule.maxLiquidityUsd !== undefined && liquidity > rule.maxLiquidityUsd) {
      return miss(`liquidity ${liquidity.toFixed(2)} above maxLiquidityUsd ${rule.maxLiquidityUsd}`)
    }
  }

  const reputationFilter = rule.reputation
  if (reputationFilter) {
    const needsRecord =
      reputationFilter.minPriorLaunches !== undefined ||
      reputationFilter.maxPriorLaunches !== undefined ||
      reputationFilter.maxRuggedLaunches !== undefined

    if (needsRecord) {
      if (!context.reputation) {
        return miss('rule filters on reputation but no reputation provider was configured')
      }
      const record = await context.reputation(event.actor)
      const prior = priorLaunchesBefore(record, event.blockNumber)
      if (
        reputationFilter.minPriorLaunches !== undefined &&
        prior < reputationFilter.minPriorLaunches
      ) {
        return miss(`deployer had ${prior} prior launches, needs ${reputationFilter.minPriorLaunches}`)
      }
      if (
        reputationFilter.maxPriorLaunches !== undefined &&
        prior > reputationFilter.maxPriorLaunches
      ) {
        return miss(`deployer had ${prior} prior launches, max is ${reputationFilter.maxPriorLaunches}`)
      }
      if (
        reputationFilter.maxRuggedLaunches !== undefined &&
        record.ruggedLaunches > reputationFilter.maxRuggedLaunches
      ) {
        return miss(
          `deployer has ${record.ruggedLaunches} drained pools, max is ${reputationFilter.maxRuggedLaunches}`,
        )
      }
    }

    if (reputationFilter.requireLpLocked === true) {
      const positionId = eventPositionId(event)
      if (positionId === null) return miss('event carries no LP position to check for a lock')
      if (!context.isLpLocked) {
        return miss('rule requires an LP lock check but no reputation provider was configured')
      }
      if (!(await context.isLpLocked(positionId))) {
        return miss(`LP position ${positionId} is not held by the launchpad locker`)
      }
    }
  }

  return matchOk(rule)
}

/**
 * Evaluate every rule against an event and return the rules that matched,
 * with their reasons. Rules are independent: one throwing lookup does not
 * suppress the others.
 */
export async function matchRules(
  rules: readonly Rule[],
  event: AlertEvent,
  context: EvaluationContext = {},
): Promise<{ rule: Rule; result: MatchResult }[]> {
  const results = await Promise.all(
    rules.map(async (rule) => {
      try {
        return { rule, result: await evaluateRule(rule, event, context) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { rule, result: miss(`evaluation failed: ${message}`) }
      }
    }),
  )
  return results.filter((entry) => entry.result.matched)
}
