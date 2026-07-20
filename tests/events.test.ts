import { describe, expect, it } from 'vitest'
import { MAINNET_ADDRESSES, NOXA_ADDRESSES, ODYSSEY_ADDRESSES, type HoodClient } from 'hoodchain'
import {
  createEventSources,
  createNoxaLaunchSource,
  createOdysseyCurveTradeSource,
  createOdysseyGraduationSource,
  createOdysseyLaunchSource,
  createWhaleTradeSource,
  eventId,
} from '../src/events/sources.js'
import { createMemoryPoolRegistry } from '../src/events/registry.js'
import { createStaticPriceOracle } from '../src/events/pricing.js'
import { LAUNCHPAD_EVENT_KINDS, isKind } from '../src/events/types.js'
import { addressUrl, explorerBase, tokenUrl, txUrl } from '../src/events/explorer.js'
import type { TokenMeta, TokenMetaReader } from '../src/events/tokens.js'
import { addr, hash } from './helpers.js'

/**
 * Source decoding, against a chain-client double.
 *
 * The double implements only the two methods the sources call (`getLogs` and
 * `getBlock`) and returns viem-shaped decoded logs. That is a test double of
 * the chain interface, which keeps these assertions about *our* decoding
 * rather than about whatever happens to be on mainnet this minute.
 */

interface FakeLog {
  address: string
  blockNumber: bigint
  logIndex: number
  transactionHash: string
  args: Record<string, unknown>
}

function fakeClient(logsByAddress: (address: unknown) => FakeLog[]): HoodClient {
  return {
    network: 'mainnet',
    chain: { id: 4663 } as never,
    account: null,
    wallet: null,
    acknowledgeStockTokenEligibility: false,
    public: {
      getBlockNumber: async () => 1_000n,
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
      getLogs: async (params: { address?: unknown }) => logsByAddress(params.address),
      multicall: async () => [],
      readContract: async () => 0n,
    } as never,
  } as unknown as HoodClient
}

const meta: TokenMetaReader = {
  get: async (token): Promise<TokenMeta> => ({ address: token, symbol: 'FAKE', name: 'Fake Token', decimals: 18 }),
  prime: () => undefined,
}

function context(client: HoodClient, registry = createMemoryPoolRegistry()) {
  return {
    client,
    oracle: createStaticPriceOracle(3_000),
    tokens: meta,
    registry,
    maxBlockTimeLookupsPerPoll: 5,
  }
}

describe('event taxonomy', () => {
  it('states which kinds each launchpad can emit', () => {
    expect(LAUNCHPAD_EVENT_KINDS.noxa).toEqual(['launch', 'whale_trade'])
    expect(LAUNCHPAD_EVENT_KINDS.odyssey).toContain('graduation')
    // The load-bearing asymmetry: NOXA has no curve, so it has no graduation.
    expect(LAUNCHPAD_EVENT_KINDS.noxa).not.toContain('graduation')
    expect(LAUNCHPAD_EVENT_KINDS.noxa).not.toContain('curve_trade')
  })

  it('derives a deterministic event id from the transaction and log index', () => {
    expect(eventId('launch', hash(1), 3)).toBe(eventId('launch', hash(1), 3))
    expect(eventId('launch', hash(1), 3)).not.toBe(eventId('launch', hash(1), 4))
  })

  it('builds explorer links against Blockscout', () => {
    const base = explorerBase('mainnet')
    expect(base).toBe('https://robinhoodchain.blockscout.com')
    expect(txUrl(base, hash(1))).toContain('/tx/0x')
    expect(tokenUrl(base, addr(1))).toContain('/token/0x')
    expect(addressUrl(base, addr(2))).toContain('/address/0x')
    expect(explorerBase('testnet')).toBe('https://explorer.testnet.chain.robinhood.com')
  })
})

describe('NOXA launches', () => {
  const log: FakeLog = {
    address: NOXA_ADDRESSES.launchFactory,
    blockNumber: 500n,
    logIndex: 2,
    transactionHash: hash(500),
    args: {
      token: addr(1),
      deployer: addr(2),
      pairToken: MAINNET_ADDRESSES.usdg,
      pool: addr(9),
      positionId: 42n,
      initialBuyAmount: 2_500_000_000n,
    },
  }

  it('decodes a launch, prices the initial buy in USDG and records the pool', async () => {
    const registry = createMemoryPoolRegistry()
    const client = fakeClient(() => [log])
    const [event] = await createNoxaLaunchSource(context(client, registry)).poll(0n, 1_000n)

    expect(event).toBeDefined()
    if (!event || !isKind(event, 'launch')) throw new Error('expected a launch event')
    expect(event.launchpad).toBe('noxa')
    expect(event.token).toBe(addr(1))
    expect(event.actor).toBe(addr(2))
    // 2,500 USDG at 6 decimals is exactly $2,500. No oracle involved.
    expect(event.usdValue).toBe(2_500)
    expect(event.instantListing).toBe(true)
    expect(event.positionId).toBe(42n)
    expect(event.timestampMs).toBe(1_700_000_000_000)
    expect(event.explorer.tx).toContain(hash(500))

    // The pool is now watchable for whale trades.
    expect(await registry.originOf(addr(1))).toBe('noxa')
  })

  it('prices a WETH-paired initial buy through the ETH rate', async () => {
    const client = fakeClient(() => [
      { ...log, args: { ...log.args, pairToken: MAINNET_ADDRESSES.weth, initialBuyAmount: 10n ** 18n } },
    ])
    const [event] = await createNoxaLaunchSource(context(client)).poll(0n, 1_000n)
    expect(event?.usdValue).toBe(3_000)
  })

  it('reports an unpriceable pair as null rather than guessing', async () => {
    const client = fakeClient(() => [{ ...log, args: { ...log.args, pairToken: addr(77) } }])
    const [event] = await createNoxaLaunchSource(context(client)).poll(0n, 1_000n)
    expect(event?.usdValue).toBeNull()
  })

  it('produces identical events when a range is polled twice', async () => {
    const client = fakeClient(() => [log])
    const source = createNoxaLaunchSource(context(client))
    const first = await source.poll(0n, 1_000n)
    const second = await source.poll(0n, 1_000n)
    expect(first[0]?.id).toBe(second[0]?.id)
  })
})

describe('Odyssey sources', () => {
  it('decodes a curve launch with no pool and no USD value', async () => {
    const client = fakeClient(() => [
      {
        address: ODYSSEY_ADDRESSES.bondingCurveFactory,
        blockNumber: 600n,
        logIndex: 0,
        transactionHash: hash(600),
        args: { token: addr(3), creator: addr(4), threshold: 10n ** 18n },
      },
    ])
    const [event] = await createOdysseyLaunchSource(context(client)).poll(0n, 1_000n)

    if (!event || !isKind(event, 'launch')) throw new Error('expected a launch event')
    expect(event.launchpad).toBe('odyssey')
    expect(event.pool).toBeNull()
    expect(event.usdValue).toBeNull()
    expect(event.instantListing).toBe(false)
  })

  it('marks a launch from the instant factory as an instant listing', async () => {
    const client = fakeClient(() => [
      {
        address: ODYSSEY_ADDRESSES.instantFactory,
        blockNumber: 600n,
        logIndex: 0,
        transactionHash: hash(600),
        args: { token: addr(3), creator: addr(4) },
      },
    ])
    const [event] = await createOdysseyLaunchSource(context(client)).poll(0n, 1_000n)
    if (!event || !isKind(event, 'launch')) throw new Error('expected a launch event')
    expect(event.instantListing).toBe(true)
  })

  it('decodes a curve trade and prices its native-ETH leg', async () => {
    const client = fakeClient(() => [
      {
        address: ODYSSEY_ADDRESSES.bondingCurveFactory,
        blockNumber: 700n,
        logIndex: 1,
        transactionHash: hash(700),
        args: {
          token: addr(3),
          trader: addr(5),
          isBuy: true,
          tokenAmount: 10n ** 18n,
          quoteAmount: 5n * 10n ** 17n,
          fee: 10n ** 15n,
          virtualQuote: 10n ** 19n,
          virtualToken: 10n ** 24n,
        },
      },
    ])
    const [event] = await createOdysseyCurveTradeSource(context(client)).poll(0n, 1_000n)

    if (!event || !isKind(event, 'curve_trade')) throw new Error('expected a curve trade')
    expect(event.side).toBe('buy')
    // 0.5 ETH at $3,000.
    expect(event.usdValue).toBe(1_500)
    expect(event.priceEth).toBeCloseTo(0.5)
  })

  it('reports a sell as a sell', async () => {
    const client = fakeClient(() => [
      {
        address: ODYSSEY_ADDRESSES.reflectionFactory,
        blockNumber: 700n,
        logIndex: 1,
        transactionHash: hash(700),
        args: { token: addr(3), trader: addr(5), isBuy: false, tokenAmount: 1n, quoteAmount: 1n },
      },
    ])
    const [event] = await createOdysseyCurveTradeSource(context(client)).poll(0n, 1_000n)
    if (!event || !isKind(event, 'curve_trade')) throw new Error('expected a curve trade')
    expect(event.side).toBe('sell')
  })

  it('decodes a graduation and keeps it even when the pool cannot be read', async () => {
    const client = fakeClient(() => [
      {
        address: ODYSSEY_ADDRESSES.bondingCurveFactory,
        blockNumber: 800n,
        logIndex: 0,
        transactionHash: hash(800),
        args: {
          token: addr(3),
          pool: addr(9),
          tokenId: 77n,
          liquidity: 10n ** 18n,
          tokenUsed: 10n ** 24n,
          usdcUsed: 12_000_000_000n,
        },
      },
    ])
    const [event] = await createOdysseyGraduationSource(context(client)).poll(0n, 1_000n)

    if (!event || !isKind(event, 'graduation')) throw new Error('expected a graduation')
    expect(event.launchpad).toBe('odyssey')
    expect(event.pool).toBe(addr(9))
    expect(event.positionId).toBe(77n)
    // The pool metadata read fails against this double, so the quote token is
    // unknown and the value is null rather than invented.
    expect(event.usdValue).toBeNull()
  })
})

describe('whale trades', () => {
  it('emits nothing when no pools are known yet', async () => {
    const client = fakeClient(() => [])
    const events = await createWhaleTradeSource(context(client)).poll(0n, 1_000n)
    expect(events).toEqual([])
  })

  it('reports the pool set is the unit of work, and skips a pool it does not track', async () => {
    const registry = createMemoryPoolRegistry([
      {
        pool: addr(9),
        token: addr(1),
        quoteToken: MAINNET_ADDRESSES.usdg,
        launchpad: 'noxa',
        createdBlock: 10n,
      },
    ])
    const client = fakeClient(() => [
      {
        address: addr(31),
        blockNumber: 900n,
        logIndex: 0,
        transactionHash: hash(900),
        args: { amount0: -1n, amount1: 1n },
      },
    ])
    const events = await createWhaleTradeSource(context(client, registry)).poll(0n, 1_000n)
    expect(events).toEqual([])
  })
})

describe('network guard', () => {
  it('refuses to build sources on testnet, where neither launchpad exists', () => {
    const testnetClient = { ...fakeClient(() => []), network: 'testnet' } as HoodClient
    expect(() => createEventSources(context(testnetClient))).toThrow(/mainnet/)
  })

  it('builds all five sources on mainnet with stable ids', () => {
    const sources = createEventSources(context(fakeClient(() => [])))
    expect(sources.map((source) => source.id)).toEqual([
      'noxa:launch',
      'odyssey:launch',
      'odyssey:curve_trade',
      'odyssey:graduation',
      'uniswap:whale_trade',
    ])
  })
})

describe('memory pool registry', () => {
  it('returns the newest pools first and always includes pinned tokens', async () => {
    const registry = createMemoryPoolRegistry()
    for (let i = 1; i <= 3; i += 1) {
      await registry.record({
        pool: addr(100 + i),
        token: addr(i),
        quoteToken: MAINNET_ADDRESSES.weth,
        launchpad: 'noxa',
        createdBlock: BigInt(i * 100),
      })
    }
    expect((await registry.active(1)).map((entry) => entry.token)).toEqual([addr(3)])
    const pinned = await registry.active(1, [addr(1)])
    expect(pinned.map((entry) => entry.token).sort()).toEqual([addr(1), addr(3)].sort())
    expect(await registry.size()).toBe(3)
  })
})

describe('price oracle', () => {
  it('treats USDG as dollars without an oracle call', () => {
    const oracle = createStaticPriceOracle(null)
    expect(oracle.usdgToUsd(1_500_000n)).toBe(1.5)
    expect(oracle.usdgToUsd(-1_500_000n)).toBe(1.5)
  })

  it('reports an unavailable ETH rate as null rather than zero', async () => {
    const oracle = createStaticPriceOracle(null)
    expect(await oracle.ethUsd()).toBeNull()
    expect(await oracle.weiToUsd(10n ** 18n)).toBeNull()
  })

  it('converts wei with a known rate', async () => {
    const oracle = createStaticPriceOracle(2_500)
    expect(await oracle.weiToUsd(2n * 10n ** 18n)).toBe(5_000)
  })
})
