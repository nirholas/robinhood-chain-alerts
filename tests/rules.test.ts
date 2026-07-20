import { describe, expect, it } from 'vitest'
import { evaluateRule, matchRules } from '../src/rules/engine.js'
import {
  formatValidationError,
  parseRule,
  ruleComplexity,
  safeParseRule,
  usesOnChainLookups,
} from '../src/rules/schema.js'
import type { DeployerReputation } from '../src/rules/reputation.js'
import { priorLaunchesBefore } from '../src/rules/reputation.js'
import {
  checkRateLimit,
  createMemoryRateLimitStore,
  rateLimitKey,
} from '../src/rules/ratelimit.js'
import { addr, curveTradeEvent, fakeClock, graduationEvent, launchEvent, whaleTradeEvent } from './helpers.js'

describe('rule schema', () => {
  it('applies defaults', () => {
    const rule = parseRule({ id: 'basic' })
    expect(rule.enabled).toBe(true)
    expect(rule.kinds).toEqual(['launch', 'curve_trade', 'graduation', 'whale_trade'])
    expect(rule.launchpads).toEqual(['noxa', 'odyssey'])
    expect(rule.tokens).toEqual([])
    expect(rule.side).toBe('any')
  })

  it('lowercases addresses so comparisons never depend on checksum casing', () => {
    const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
    const rule = parseRule({ id: 'watch', tokens: [mixed] })
    expect(rule.tokens[0]).toBe(mixed.toLowerCase())
  })

  it('rejects an unknown field rather than silently ignoring it', () => {
    const result = safeParseRule({ id: 'typo', minUSD: 100 })
    expect(result.success).toBe(false)
  })

  it('rejects minUsd above maxUsd', () => {
    const result = safeParseRule({ id: 'bad', minUsd: 100, maxUsd: 10 })
    expect(result.success).toBe(false)
    if (!result.success) expect(formatValidationError(result.error)).toMatch(/minUsd must not exceed maxUsd/)
  })

  it('rejects a NOXA-only graduation rule, which can never fire', () => {
    const result = safeParseRule({ id: 'impossible', kinds: ['graduation'], launchpads: ['noxa'] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(formatValidationError(result.error)).toMatch(/instant launcher/)
    }
  })

  it('accepts an Odyssey graduation rule', () => {
    expect(safeParseRule({ id: 'ok', kinds: ['graduation'], launchpads: ['odyssey'] }).success).toBe(true)
  })

  it('rejects a malformed rule id', () => {
    expect(safeParseRule({ id: 'Has Spaces' }).success).toBe(false)
  })

  it('scores complexity and flags on-chain lookups', () => {
    const simple = parseRule({ id: 'simple', minUsd: 1000 })
    expect(ruleComplexity(simple)).toBe(1)
    expect(usesOnChainLookups(simple)).toBe(false)

    const heavy = parseRule({
      id: 'heavy',
      minUsd: 1000,
      maxUsd: 5000,
      minLiquidityUsd: 10_000,
      side: 'buy',
      reputation: { minPriorLaunches: 1, maxRuggedLaunches: 0 },
    })
    expect(ruleComplexity(heavy)).toBe(6)
    expect(usesOnChainLookups(heavy)).toBe(true)
  })
})

describe('rule engine filters', () => {
  it('matches an unfiltered rule', async () => {
    const result = await evaluateRule(parseRule({ id: 'all' }), launchEvent())
    expect(result.matched).toBe(true)
  })

  it('does not match a disabled rule', async () => {
    const result = await evaluateRule(parseRule({ id: 'off', enabled: false }), launchEvent())
    expect(result.matched).toBe(false)
    expect(result.reason).toMatch(/disabled/)
  })

  it('filters by kind', async () => {
    const rule = parseRule({ id: 'whales', kinds: ['whale_trade'] })
    expect((await evaluateRule(rule, whaleTradeEvent())).matched).toBe(true)
    expect((await evaluateRule(rule, launchEvent())).matched).toBe(false)
  })

  it('filters by launchpad', async () => {
    const rule = parseRule({ id: 'odyssey-only', launchpads: ['odyssey'] })
    expect((await evaluateRule(rule, curveTradeEvent())).matched).toBe(true)
    expect((await evaluateRule(rule, launchEvent({ launchpad: 'noxa' }))).matched).toBe(false)
  })

  it('filters by minUsd and maxUsd', async () => {
    const rule = parseRule({ id: 'band', minUsd: 1_000, maxUsd: 10_000 })
    expect((await evaluateRule(rule, whaleTradeEvent({ usdValue: 5_000 }))).matched).toBe(true)
    expect((await evaluateRule(rule, whaleTradeEvent({ usdValue: 500 }))).matched).toBe(false)
    expect((await evaluateRule(rule, whaleTradeEvent({ usdValue: 50_000 }))).matched).toBe(false)
  })

  it('treats an unknown USD value as a miss, never as a pass', async () => {
    const rule = parseRule({ id: 'min', minUsd: 1 })
    const result = await evaluateRule(rule, whaleTradeEvent({ usdValue: null }))
    expect(result.matched).toBe(false)
    expect(result.reason).toMatch(/no USD value/)

    const maxRule = parseRule({ id: 'max', maxUsd: 1_000_000 })
    expect((await evaluateRule(maxRule, whaleTradeEvent({ usdValue: null }))).matched).toBe(false)
  })

  it('filters by token watchlist', async () => {
    const rule = parseRule({ id: 'watch', tokens: [addr(1)] })
    expect((await evaluateRule(rule, launchEvent({ token: addr(1) }))).matched).toBe(true)
    expect((await evaluateRule(rule, launchEvent({ token: addr(7) }))).matched).toBe(false)
  })

  it('filters by deployer watchlist and exclusion list', async () => {
    const watch = parseRule({ id: 'dev', deployers: [addr(2)] })
    expect((await evaluateRule(watch, launchEvent({ actor: addr(2) }))).matched).toBe(true)
    expect((await evaluateRule(watch, launchEvent({ actor: addr(3) }))).matched).toBe(false)

    const block = parseRule({ id: 'block', excludeDeployers: [addr(2)] })
    expect((await evaluateRule(block, launchEvent({ actor: addr(2) }))).matched).toBe(false)
    expect((await evaluateRule(block, launchEvent({ actor: addr(3) }))).matched).toBe(true)
  })

  it('filters by side, and reports that side does not apply to launches', async () => {
    const buys = parseRule({ id: 'buys', side: 'buy' })
    expect((await evaluateRule(buys, whaleTradeEvent({ side: 'buy' }))).matched).toBe(true)
    expect((await evaluateRule(buys, whaleTradeEvent({ side: 'sell' }))).matched).toBe(false)
    const onLaunch = await evaluateRule(buys, launchEvent())
    expect(onLaunch.matched).toBe(false)
    expect(onLaunch.reason).toMatch(/does not apply/)
  })

  it('filters by liquidity through the lazy reader', async () => {
    const rule = parseRule({ id: 'liq', minLiquidityUsd: 10_000 })
    let calls = 0
    const context = {
      liquidityUsd: async () => {
        calls += 1
        return 25_000
      },
    }
    expect((await evaluateRule(rule, launchEvent(), context)).matched).toBe(true)
    expect(calls).toBe(1)

    expect((await evaluateRule(rule, launchEvent(), { liquidityUsd: async () => 500 })).matched).toBe(false)
    expect((await evaluateRule(rule, launchEvent(), { liquidityUsd: async () => null })).matched).toBe(false)
  })

  it('does not perform on-chain lookups for a rule rejected on a cheap filter', async () => {
    const rule = parseRule({ id: 'lazy', kinds: ['whale_trade'], minLiquidityUsd: 1 })
    let calls = 0
    const result = await evaluateRule(rule, launchEvent(), {
      liquidityUsd: async () => {
        calls += 1
        return 1_000_000
      },
    })
    expect(result.matched).toBe(false)
    expect(calls).toBe(0)
  })

  it('reports a missing liquidity reader instead of matching blindly', async () => {
    const rule = parseRule({ id: 'liq', minLiquidityUsd: 10 })
    const result = await evaluateRule(rule, launchEvent())
    expect(result.matched).toBe(false)
    expect(result.reason).toMatch(/no liquidity reader/)
  })

  it('filters by deployer reputation relative to the event block', async () => {
    const record: DeployerReputation = {
      deployer: addr(2),
      launches: [
        { launchpad: 'noxa', token: addr(11), pool: null, quoteToken: null, positionId: null, blockNumber: 100n },
        { launchpad: 'noxa', token: addr(12), pool: null, quoteToken: null, positionId: null, blockNumber: 5_000n },
      ],
      lockedLaunches: 1,
      ruggedLaunches: 1,
      inspected: 2,
      computedAtMs: 0,
    }
    expect(priorLaunchesBefore(record, 1_000n)).toBe(1)

    const context = { reputation: async () => record }
    const veteran = parseRule({ id: 'veteran', reputation: { minPriorLaunches: 1 } })
    expect((await evaluateRule(veteran, launchEvent({ block: 1_000n }), context)).matched).toBe(true)
    expect((await evaluateRule(veteran, launchEvent({ block: 50n }), context)).matched).toBe(false)

    const clean = parseRule({ id: 'clean', reputation: { maxRuggedLaunches: 0 } })
    expect((await evaluateRule(clean, launchEvent({ block: 1_000n }), context)).matched).toBe(false)

    const tolerant = parseRule({ id: 'tolerant', reputation: { maxRuggedLaunches: 2 } })
    expect((await evaluateRule(tolerant, launchEvent({ block: 1_000n }), context)).matched).toBe(true)
  })

  it('filters on LP lock, and misses when the event carries no position', async () => {
    const rule = parseRule({ id: 'locked', reputation: { requireLpLocked: true } })
    const locked = { isLpLocked: async () => true }
    expect((await evaluateRule(rule, launchEvent({ positionId: 42n }), locked)).matched).toBe(true)
    expect(
      (await evaluateRule(rule, launchEvent({ positionId: 42n }), { isLpLocked: async () => false })).matched,
    ).toBe(false)

    const noPosition = await evaluateRule(rule, curveTradeEvent(), locked)
    expect(noPosition.matched).toBe(false)
    expect(noPosition.reason).toMatch(/no LP position/)
  })

  it('graduation events carry a position id, so the lock filter applies to them', async () => {
    const rule = parseRule({ id: 'locked', kinds: ['graduation'], launchpads: ['odyssey'], reputation: { requireLpLocked: true } })
    const result = await evaluateRule(rule, graduationEvent(), { isLpLocked: async () => true })
    expect(result.matched).toBe(true)
  })

  it('isolates a throwing lookup to its own rule', async () => {
    const good = parseRule({ id: 'good' })
    const bad = parseRule({ id: 'bad', minLiquidityUsd: 1 })
    const matches = await matchRules([good, bad], launchEvent(), {
      liquidityUsd: async () => {
        throw new Error('rpc exploded')
      },
    })
    expect(matches.map((entry) => entry.rule.id)).toEqual(['good'])
  })
})

describe('rate limits', () => {
  it('allows everything when a rule sets no limit', async () => {
    const store = createMemoryRateLimitStore()
    const decision = await checkRateLimit(store, 'k', undefined, 0)
    expect(decision.allowed).toBe(true)
  })

  it('enforces minIntervalSeconds', async () => {
    const store = createMemoryRateLimitStore()
    const clock = fakeClock(0)
    const config = { minIntervalSeconds: 60 }
    expect((await checkRateLimit(store, 'k', config, clock.now())).allowed).toBe(true)
    await store.record('k', 'sub', clock.now())

    clock.advance(30_000)
    const blocked = await checkRateLimit(store, 'k', config, clock.now())
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAtMs).toBe(60_000)

    clock.advance(31_000)
    expect((await checkRateLimit(store, 'k', config, clock.now())).allowed).toBe(true)
  })

  it('enforces maxPerHour on a rolling window', async () => {
    const store = createMemoryRateLimitStore()
    const clock = fakeClock(0)
    const config = { maxPerHour: 2 }
    for (let i = 0; i < 2; i += 1) {
      expect((await checkRateLimit(store, 'k', config, clock.now())).allowed).toBe(true)
      await store.record('k', 'sub', clock.now())
      clock.advance(1_000)
    }
    expect((await checkRateLimit(store, 'k', config, clock.now())).allowed).toBe(false)

    clock.advance(3_600_001)
    expect((await checkRateLimit(store, 'k', config, clock.now())).allowed).toBe(true)
  })

  it('tracks subscriber throughput separately from rule buckets', async () => {
    const store = createMemoryRateLimitStore()
    await store.record(rateLimitKey('sub-1', 'rule-a'), 'user-1', 1_000)
    await store.record(rateLimitKey('sub-1', 'rule-b'), 'user-1', 1_100)
    expect(await store.countSince(rateLimitKey('sub-1', 'rule-a'), 0)).toBe(1)
    expect(await store.countForSubscriberSince('user-1', 0)).toBe(2)
    expect(await store.countForSubscriberSince('user-2', 0)).toBe(0)
  })

  it('keys buckets per subscription and rule', () => {
    expect(rateLimitKey('sub', 'rule')).toBe('sub:rule')
  })
})
