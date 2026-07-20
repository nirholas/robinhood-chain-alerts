import { describe, expect, it } from 'vitest'
import { parseRule } from '../src/rules/schema.js'
import {
  TIER_POLICIES,
  canAddRule,
  canAddSubscription,
  isRuleAllowed,
  policyFor,
} from '../src/tiers/policy.js'
import {
  accrueExpiry,
  chainEntitlementProviders,
  createStaticEntitlementProvider,
  linkMessage,
  verifyWalletLink,
  type EntitlementProvider,
} from '../src/tiers/entitlements.js'
import { createEntitlementGate } from '../src/tiers/enforce.js'

const DAY = 86_400_000

describe('tier policy', () => {
  it('caps free subscriptions and allows more on premium', () => {
    expect(canAddSubscription(TIER_POLICIES.free, 0).allowed).toBe(true)
    const denied = canAddSubscription(TIER_POLICIES.free, 1)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/free tier allows 1 subscription/)
    expect(canAddSubscription(TIER_POLICIES.premium, 5).allowed).toBe(true)
  })

  it('caps rules per subscription', () => {
    const rule = parseRule({ id: 'r', kinds: ['launch'] })
    expect(canAddRule(TIER_POLICIES.free, rule, 2).allowed).toBe(true)
    expect(canAddRule(TIER_POLICIES.free, rule, 3).allowed).toBe(false)
  })

  it('keeps the curve-trade firehose off the free tier', () => {
    const rule = parseRule({ id: 'curve', kinds: ['curve_trade'], launchpads: ['odyssey'] })
    const denied = isRuleAllowed(TIER_POLICIES.free, rule)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/curve_trade/)
    expect(isRuleAllowed(TIER_POLICIES.premium, rule).allowed).toBe(true)
  })

  it('gates liquidity and reputation filters behind premium', () => {
    const liquidity = parseRule({ id: 'liq', kinds: ['launch'], minLiquidityUsd: 10_000 })
    expect(isRuleAllowed(TIER_POLICIES.free, liquidity).allowed).toBe(false)
    expect(isRuleAllowed(TIER_POLICIES.premium, liquidity).allowed).toBe(true)

    const reputation = parseRule({ id: 'rep', kinds: ['launch'], reputation: { maxRuggedLaunches: 0 } })
    expect(isRuleAllowed(TIER_POLICIES.free, reputation).allowed).toBe(false)
  })

  it('caps rule complexity', () => {
    const heavy = parseRule({
      id: 'heavy',
      kinds: ['whale_trade'],
      minUsd: 1,
      maxUsd: 2,
      side: 'buy',
      rateLimit: { maxPerHour: 5 },
    })
    const denied = isRuleAllowed(TIER_POLICIES.free, heavy)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/4 filters/)
  })

  it('caps watchlist size', () => {
    const tokens = Array.from({ length: 6 }, (_unused, index) => `0x${String(index).repeat(40)}`)
    const rule = parseRule({ id: 'watch', kinds: ['launch'], tokens })
    expect(isRuleAllowed(TIER_POLICIES.free, rule).allowed).toBe(false)
    expect(isRuleAllowed(TIER_POLICIES.premium, rule).allowed).toBe(true)
  })

  it('applies per-deployment overrides without losing the tier name', () => {
    const policy = policyFor('free', { free: { maxAlertsPerHour: 5 } })
    expect(policy.tier).toBe('free')
    expect(policy.maxAlertsPerHour).toBe(5)
    expect(policy.deliveryDelayMs).toBe(TIER_POLICIES.free.deliveryDelayMs)
  })
})

describe('entitlement providers', () => {
  it('grants premium from configuration', async () => {
    const provider = createStaticEntitlementProvider({ premiumSubscribers: ['telegram:1'] })
    expect((await provider.get('telegram:1')).tier).toBe('premium')
    expect((await provider.get('telegram:2')).tier).toBe('free')
  })

  it('supports an all-premium private deployment', async () => {
    const provider = createStaticEntitlementProvider({ allPremium: true })
    expect((await provider.get('anyone')).tier).toBe('premium')
  })

  it('takes the first premium answer when providers are chained', async () => {
    const never: EntitlementProvider = {
      get: async (subscriberId) => ({ subscriberId, tier: 'free', expiresAtMs: null, source: 'never' }),
    }
    const always: EntitlementProvider = {
      get: async (subscriberId) => ({ subscriberId, tier: 'premium', expiresAtMs: null, source: 'always' }),
    }
    expect((await chainEntitlementProviders(never, always).get('x')).source).toBe('always')
    expect((await chainEntitlementProviders(never, never).get('x')).tier).toBe('free')
  })
})

describe('USDG subscription accrual', () => {
  it('buys one period per whole price paid', () => {
    const expiry = accrueExpiry([{ atMs: 0, amountUsdg: 25 }], 25, 30)
    expect(expiry).toBe(30 * DAY)
  })

  it('buys several periods from one larger payment', () => {
    expect(accrueExpiry([{ atMs: 0, amountUsdg: 75 }], 25, 30)).toBe(90 * DAY)
  })

  it('ignores a payment below the price instead of granting a partial period', () => {
    expect(accrueExpiry([{ atMs: 0, amountUsdg: 10 }], 25, 30)).toBeNull()
  })

  it('extends rather than overwrites when renewing early', () => {
    const expiry = accrueExpiry(
      [
        { atMs: 0, amountUsdg: 25 },
        { atMs: 10 * DAY, amountUsdg: 25 },
      ],
      25,
      30,
    )
    expect(expiry).toBe(60 * DAY)
  })

  it('restarts from the payment when the previous period had already lapsed', () => {
    const expiry = accrueExpiry(
      [
        { atMs: 0, amountUsdg: 25 },
        { atMs: 100 * DAY, amountUsdg: 25 },
      ],
      25,
      30,
    )
    expect(expiry).toBe(130 * DAY)
  })

  it('orders payments before accruing, whatever order they arrive in', () => {
    const ordered = accrueExpiry(
      [
        { atMs: 10 * DAY, amountUsdg: 25 },
        { atMs: 0, amountUsdg: 25 },
      ],
      25,
      30,
    )
    expect(ordered).toBe(60 * DAY)
  })
})

describe('wallet linking', () => {
  it('builds a stable message containing the subscriber and nonce', () => {
    const message = linkMessage('telegram:1', 'nonce-abc')
    expect(message).toContain('telegram:1')
    expect(message).toContain('nonce-abc')
  })

  it('rejects a malformed signature or address without throwing', async () => {
    expect(await verifyWalletLink('telegram:1', 'n', '0x1234', 'not-a-signature')).toBeNull()
    expect(
      await verifyWalletLink('telegram:1', 'n', '0x0000000000000000000000000000000000000001', `0x${'0'.repeat(130)}`),
    ).toBeNull()
  })

  it('accepts a genuine signature and returns the checksummed address', async () => {
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const nonce = 'nonce-xyz'
    const signature = await account.signMessage({ message: linkMessage('telegram:1', nonce) })

    expect(await verifyWalletLink('telegram:1', nonce, account.address, signature)).toBe(account.address)
    // A signature for one subscriber cannot be replayed for another.
    expect(await verifyWalletLink('telegram:2', nonce, account.address, signature)).toBeNull()
    // Nor with a different nonce.
    expect(await verifyWalletLink('telegram:1', 'other', account.address, signature)).toBeNull()
  })
})

describe('entitlement gate', () => {
  const gate = createEntitlementGate({
    provider: createStaticEntitlementProvider({ premiumSubscribers: ['premium-user'] }),
  })

  it('resolves tier and policy together', async () => {
    const free = await gate.resolve('free-user')
    expect(free.policy.tier).toBe('free')
    const premium = await gate.resolve('premium-user')
    expect(premium.policy.tier).toBe('premium')
  })

  it('reports the tier delivery delay', async () => {
    expect(await gate.deliveryDelayMs('free-user')).toBe(60_000)
    expect(await gate.deliveryDelayMs('premium-user')).toBe(0)
  })

  it('enforces throughput per tier', async () => {
    expect((await gate.checkThroughput('free-user', 29)).allowed).toBe(true)
    const denied = await gate.checkThroughput('free-user', 30)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/hourly alert cap/)
    expect((await gate.checkThroughput('premium-user', 30)).allowed).toBe(true)
  })
})
