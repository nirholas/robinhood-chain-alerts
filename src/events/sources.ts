import { getAddress, type Address, type Hash } from 'viem'
import {
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  odysseyTradedEvent,
  odysseyPoolMigratedEvent,
  type HoodClient,
} from 'hoodchain'
import { loadPoolInfo, uniswapV3SwapEvent, type PoolInfo } from 'hoodkit'
import { addressUrl, explorerBase, tokenUrl, txUrl } from './explorer.js'
import { batchAddresses, fetchLogRange, type FetchLogRangeOptions } from './logs.js'
import { createBlockTimeReader, type BlockTimeReader } from './blocktime.js'
import { quoteTokens, type PriceOracle } from './pricing.js'
import type { PoolRegistry } from './registry.js'
import type { TokenMetaReader } from './tokens.js'
import type {
  AlertEvent,
  CurveTradeEvent,
  ExplorerLinks,
  GraduationEvent,
  LaunchEvent,
  Launchpad,
  WhaleTradeEvent,
} from './types.js'

/**
 * The event sources: one per on-chain surface, each responsible for turning a
 * confirmed block range into normalized {@link AlertEvent}s.
 *
 * Sources are deliberately *pull* based (`poll(from, to)`) rather than
 * push/subscription based. The service owns the block cursor and persists it,
 * so a source that is asked for the same range twice must produce identical
 * events, and it does: every event id is derived from `txHash` and `logIndex`.
 * That is what makes crash recovery safe.
 */

/** A pollable on-chain source of alert events. */
export interface EventSource {
  /** Stable identifier, used as the persisted cursor key. Never change it. */
  id: string
  /** Human label for logs and `/metrics`. */
  label: string
  /** Earliest block this source can produce events from. */
  startBlock: bigint
  /** Decode `[from, to]` inclusive into events. Must be deterministic. */
  poll(from: bigint, to: bigint): Promise<AlertEvent[]>
}

/** Wiring shared by every source. */
export interface SourceContext {
  client: HoodClient
  oracle: PriceOracle
  tokens: TokenMetaReader
  registry: PoolRegistry
  /** Optional shared block-timestamp reader (one is created when omitted). */
  blockTimes?: BlockTimeReader
  /** Max `eth_getBlockByNumber` calls per poll, for timestamps. @defaultValue `25` */
  maxBlockTimeLookupsPerPoll?: number
  /** Retry/bisect options passed to {@link fetchLogRange}. */
  logOptions?: FetchLogRangeOptions
  /**
   * Tokens that must always be in the whale watcher's pool set (subscriber
   * watchlists). Called once per whale poll.
   */
  pinnedTokens?: () => Promise<readonly Address[]>
  /**
   * Max pools the whale watcher queries per poll, newest first.
   * @defaultValue `400`
   */
  whalePoolLimit?: number
  /**
   * Service-wide floor for whale trades in USD. Swaps below this never become
   * events at all, which keeps the delivery pipeline from doing per-subscriber
   * work on dust. Per-subscription `minUsd` rules are applied on top and can
   * only be stricter.
   * @defaultValue `1000`
   */
  whaleMinUsd?: number
  /** Pools per address-filtered `eth_getLogs` call. @defaultValue `200` */
  whalePoolBatchSize?: number
}

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

/** Deterministic event id: reprocessing a range regenerates the same value. */
export function eventId(kind: string, transactionHash: Hash, logIndex: number): string {
  return `${kind}:${transactionHash.toLowerCase()}:${logIndex}`
}

function links(base: string, token: Address, actor: Address, hash: Hash, pool?: Address): ExplorerLinks {
  return {
    tx: txUrl(base, hash),
    token: tokenUrl(base, token),
    actor: addressUrl(base, actor),
    ...(pool ? { pool: addressUrl(base, pool) } : {}),
  }
}

/**
 * Value a raw amount of a quote token in USD. Returns `null` for any token
 * that is neither USDG nor WETH, because there is no honest rate for it.
 */
async function valueQuote(
  ctx: SourceContext,
  quoteToken: Address,
  raw: bigint,
): Promise<number | null> {
  const { weth, usdg } = quoteTokens(ctx.client)
  const token = quoteToken.toLowerCase()
  if (token === usdg.toLowerCase()) return ctx.oracle.usdgToUsd(raw)
  if (token === weth.toLowerCase()) return ctx.oracle.weiToUsd(raw)
  return null
}

function assertMainnet(client: HoodClient): void {
  if (client.network !== 'mainnet') {
    throw new Error(
      'hood-alerts: the NOXA and Odyssey launchpads are deployed on Robinhood Chain mainnet (chain 4663) only. ' +
        'Create the client with { chain: "mainnet" } (the default) to watch them.',
    )
  }
}

/**
 * Build every event source for a mainnet client.
 *
 * @throws when the client targets testnet: neither launchpad exists there, so
 * silently returning an empty source list would look like "no launches".
 *
 * @example
 * ```ts
 * import { createHoodClient } from 'hoodchain'
 * import {
 *   createEventSources, createPriceOracle, createTokenMetaReader, createMemoryPoolRegistry,
 * } from 'hood-alerts/events'
 *
 * const hood = createHoodClient()
 * const sources = createEventSources({
 *   client: hood,
 *   oracle: createPriceOracle(hood),
 *   tokens: createTokenMetaReader(hood),
 *   registry: createMemoryPoolRegistry(),
 * })
 * const head = await hood.public.getBlockNumber()
 * for (const source of sources) {
 *   console.log(source.label, (await source.poll(head - 2_000n, head)).length)
 * }
 * ```
 */
export function createEventSources(ctx: SourceContext): EventSource[] {
  assertMainnet(ctx.client)
  return [
    createNoxaLaunchSource(ctx),
    createOdysseyLaunchSource(ctx),
    createOdysseyCurveTradeSource(ctx),
    createOdysseyGraduationSource(ctx),
    createWhaleTradeSource(ctx),
  ]
}

function blockTimes(ctx: SourceContext): BlockTimeReader {
  ctx.blockTimes ??= createBlockTimeReader(ctx.client)
  return ctx.blockTimes
}

async function stampTimes(
  ctx: SourceContext,
  events: AlertEvent[],
): Promise<AlertEvent[]> {
  if (events.length === 0) return events
  const reader = blockTimes(ctx)
  const times = await reader.getMany(
    events.map((e) => e.blockNumber),
    ctx.maxBlockTimeLookupsPerPoll ?? 25,
  )
  for (const event of events) event.timestampMs = times.get(event.blockNumber) ?? null
  return events
}

/** NOXA `TokenLaunched`: an instant listing with a live Uniswap v3 pool. */
export function createNoxaLaunchSource(ctx: SourceContext): EventSource {
  const base = explorerBase(ctx.client.network)
  return {
    id: 'noxa:launch',
    label: 'NOXA launches',
    startBlock: NOXA_ADDRESSES.deployBlock,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      const logs = await fetchLogRange(
        (lo, hi) =>
          ctx.client.public.getLogs({
            address: NOXA_ADDRESSES.launchFactory,
            event: noxaTokenLaunchedEvent,
            fromBlock: lo,
            toBlock: hi,
          }),
        from,
        to,
        ctx.logOptions ?? {},
      )

      const events: LaunchEvent[] = []
      for (const log of logs) {
        const token = log.args.token as Address | undefined
        const deployer = log.args.deployer as Address | undefined
        if (!token || !deployer) continue
        const pool = (log.args.pool as Address | undefined) ?? null
        const pairToken = (log.args.pairToken as Address | undefined) ?? null
        const initialBuyAmount = (log.args.initialBuyAmount as bigint | undefined) ?? 0n

        if (pool && pairToken) {
          await ctx.registry.record({
            pool: getAddress(pool),
            token: getAddress(token),
            quoteToken: getAddress(pairToken),
            launchpad: 'noxa',
            createdBlock: log.blockNumber,
          })
        }
        const meta = await ctx.tokens.get(token)
        const usdValue =
          pairToken && initialBuyAmount > 0n ? await valueQuote(ctx, pairToken, initialBuyAmount) : null

        events.push({
          id: eventId('launch', log.transactionHash, log.logIndex),
          kind: 'launch',
          launchpad: 'noxa',
          token: getAddress(token),
          symbol: meta.symbol,
          name: meta.name,
          actor: getAddress(deployer),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestampMs: null,
          usdValue,
          explorer: links(base, token, deployer, log.transactionHash, pool ?? undefined),
          pool: pool ? getAddress(pool) : null,
          pairToken: pairToken ? getAddress(pairToken) : null,
          initialBuyAmount,
          positionId: (log.args.positionId as bigint | undefined) ?? null,
          // NOXA has no bonding curve at all: a launch is already a listing.
          instantListing: true,
        })
      }
      return stampTimes(ctx, events)
    },
  }
}

/** The Odyssey `TokenCreated`: a bonding curve opening. */
export function createOdysseyLaunchSource(ctx: SourceContext): EventSource {
  const base = explorerBase(ctx.client.network)
  return {
    id: 'odyssey:launch',
    label: 'Odyssey launches',
    startBlock: NOXA_ADDRESSES.deployBlock,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      const logs = await fetchLogRange(
        (lo, hi) =>
          ctx.client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyTokenCreatedEvent,
            fromBlock: lo,
            toBlock: hi,
          }),
        from,
        to,
        ctx.logOptions ?? {},
      )

      const events: LaunchEvent[] = []
      for (const log of logs) {
        const token = log.args.token as Address | undefined
        const creator = log.args.creator as Address | undefined
        if (!token || !creator) continue
        const meta = await ctx.tokens.get(token)
        events.push({
          id: eventId('launch', log.transactionHash, log.logIndex),
          kind: 'launch',
          launchpad: 'odyssey',
          token: getAddress(token),
          symbol: meta.symbol,
          name: meta.name,
          actor: getAddress(creator),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestampMs: null,
          // The curve holds liquidity until graduation, so a new Odyssey token
          // has no pool and no priceable notional at creation time.
          usdValue: null,
          explorer: links(base, token, creator, log.transactionHash),
          pool: null,
          pairToken: null,
          initialBuyAmount: 0n,
          positionId: null,
          instantListing:
            log.address.toLowerCase() === ODYSSEY_ADDRESSES.instantFactory.toLowerCase(),
        })
      }
      return stampTimes(ctx, events)
    },
  }
}

/** The Odyssey `Traded`: every bonding-curve buy and sell. */
export function createOdysseyCurveTradeSource(ctx: SourceContext): EventSource {
  const base = explorerBase(ctx.client.network)
  return {
    id: 'odyssey:curve_trade',
    label: 'Odyssey curve trades',
    startBlock: NOXA_ADDRESSES.deployBlock,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      const logs = await fetchLogRange(
        (lo, hi) =>
          ctx.client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyTradedEvent,
            fromBlock: lo,
            toBlock: hi,
          }),
        from,
        to,
        ctx.logOptions ?? {},
      )

      const events: CurveTradeEvent[] = []
      for (const log of logs) {
        const token = log.args.token as Address | undefined
        const trader = log.args.trader as Address | undefined
        if (!token || !trader) continue
        const tokenAmount = (log.args.tokenAmount as bigint | undefined) ?? 0n
        const quoteAmountWei = (log.args.quoteAmount as bigint | undefined) ?? 0n
        const meta = await ctx.tokens.get(token)
        // The curve quotes in native ETH, so the ETH/USD rate from live
        // WETH/USDG liquidity is the only conversion involved.
        const usdValue = await ctx.oracle.weiToUsd(quoteAmountWei)
        const priceEth =
          tokenAmount > 0n
            ? Number(quoteAmountWei) / Number(tokenAmount)
            : null

        events.push({
          id: eventId('curve_trade', log.transactionHash, log.logIndex),
          kind: 'curve_trade',
          launchpad: 'odyssey',
          token: getAddress(token),
          symbol: meta.symbol,
          name: meta.name,
          actor: getAddress(trader),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestampMs: null,
          usdValue,
          explorer: links(base, token, trader, log.transactionHash),
          side: (log.args.isBuy as boolean | undefined) ? 'buy' : 'sell',
          tokenAmount,
          quoteAmountWei,
          feeWei: (log.args.fee as bigint | undefined) ?? 0n,
          virtualQuoteWei: (log.args.virtualQuote as bigint | undefined) ?? 0n,
          virtualTokenAmount: (log.args.virtualToken as bigint | undefined) ?? 0n,
          priceEth,
        })
      }
      return stampTimes(ctx, events)
    },
  }
}

/**
 * The Odyssey `PoolMigrated`: the curve filled and liquidity moved to a locked
 * Uniswap v3 pool. This is the only real graduation event on the chain. NOXA
 * cannot emit one, by construction.
 */
export function createOdysseyGraduationSource(ctx: SourceContext): EventSource {
  const base = explorerBase(ctx.client.network)
  return {
    id: 'odyssey:graduation',
    label: 'Odyssey graduations',
    startBlock: NOXA_ADDRESSES.deployBlock,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      const logs = await fetchLogRange(
        (lo, hi) =>
          ctx.client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyPoolMigratedEvent,
            fromBlock: lo,
            toBlock: hi,
          }),
        from,
        to,
        ctx.logOptions ?? {},
      )

      const events: GraduationEvent[] = []
      for (const log of logs) {
        const token = log.args.token as Address | undefined
        const pool = log.args.pool as Address | undefined
        if (!token || !pool) continue
        const quoteUsed = (log.args.usdcUsed as bigint | undefined) ?? 0n

        // Read the pool to learn which side is the quote token, then record it
        // so the whale watcher starts covering this graduate immediately.
        let quoteToken: Address | null = null
        try {
          const info = await loadPoolInfo(ctx.client, pool)
          quoteToken =
            info.token0.toLowerCase() === token.toLowerCase() ? info.token1 : info.token0
          await ctx.registry.record({
            pool: getAddress(pool),
            token: getAddress(token),
            quoteToken,
            launchpad: 'odyssey',
            createdBlock: log.blockNumber,
          })
        } catch {
          // Pool metadata unavailable (pruned archive state, RPC blip). The
          // graduation is still real and still worth alerting on.
          quoteToken = null
        }

        const meta = await ctx.tokens.get(token)
        const usdValue = quoteToken ? await valueQuote(ctx, quoteToken, quoteUsed) : null

        events.push({
          id: eventId('graduation', log.transactionHash, log.logIndex),
          kind: 'graduation',
          launchpad: 'odyssey',
          token: getAddress(token),
          symbol: meta.symbol,
          name: meta.name,
          // A migration is executed by the factory on behalf of the curve, so
          // the closest thing to an actor is the factory that emitted it.
          actor: getAddress(log.address),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestampMs: null,
          usdValue,
          explorer: links(base, token, log.address as Address, log.transactionHash, pool),
          pool: getAddress(pool),
          positionId: (log.args.tokenId as bigint | undefined) ?? 0n,
          liquidity: (log.args.liquidity as bigint | undefined) ?? 0n,
          tokenUsed: (log.args.tokenUsed as bigint | undefined) ?? 0n,
          quoteUsed,
        })
      }
      return stampTimes(ctx, events)
    },
  }
}

/**
 * Uniswap v3 swaps on known memecoin pools, above the service-wide USD floor.
 *
 * The pool set comes from {@link PoolRegistry}: NOXA pools are known from
 * launch, Odyssey pools from graduation. That is a deliberate design choice,
 * not a shortcut. A topic-only `Swap` query across the whole chain overflows
 * the RPC's 10,000-log result cap inside 2,000 blocks, so "watch every pool"
 * is not something the public endpoint can serve. Watching the launchpad pool
 * set is both cheaper and exactly the product: memecoin whale alerts.
 */
export function createWhaleTradeSource(ctx: SourceContext): EventSource {
  const base = explorerBase(ctx.client.network)
  const poolInfoCache = new Map<string, PoolInfo>()
  const minUsd = ctx.whaleMinUsd ?? 1000

  async function poolInfo(pool: Address): Promise<PoolInfo | null> {
    const key = pool.toLowerCase()
    const hit = poolInfoCache.get(key)
    if (hit) return hit
    try {
      const info = await loadPoolInfo(ctx.client, pool)
      poolInfoCache.set(key, info)
      return info
    } catch {
      return null
    }
  }

  return {
    id: 'uniswap:whale_trade',
    label: 'Whale trades',
    startBlock: NOXA_ADDRESSES.deployBlock,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      const pinned = ctx.pinnedTokens ? await ctx.pinnedTokens() : []
      const entries = await ctx.registry.active(ctx.whalePoolLimit ?? 400, pinned)
      if (entries.length === 0) return []

      const byPool = new Map(entries.map((entry) => [entry.pool.toLowerCase(), entry]))
      const batches = batchAddresses(
        entries.map((entry) => entry.pool),
        ctx.whalePoolBatchSize ?? 200,
      )

      const logs = (
        await Promise.all(
          batches.map((batch) =>
            fetchLogRange(
              (lo, hi) =>
                ctx.client.public.getLogs({
                  address: batch,
                  event: uniswapV3SwapEvent,
                  fromBlock: lo,
                  toBlock: hi,
                }),
              from,
              to,
              ctx.logOptions ?? {},
            ),
          ),
        )
      ).flat()

      const events: WhaleTradeEvent[] = []
      for (const log of logs) {
        const entry = byPool.get(log.address.toLowerCase())
        if (!entry) continue
        const info = await poolInfo(entry.pool)
        if (!info) continue

        const amount0 = (log.args.amount0 as bigint | undefined) ?? 0n
        const amount1 = (log.args.amount1 as bigint | undefined) ?? 0n
        const quoteIsToken0 = info.token0.toLowerCase() === entry.quoteToken.toLowerCase()
        const quoteRaw = quoteIsToken0 ? amount0 : amount1
        const tokenRaw = quoteIsToken0 ? amount1 : amount0
        if (quoteRaw === 0n || tokenRaw === 0n) continue

        const usdValue = await valueQuote(ctx, entry.quoteToken, quoteRaw)
        if (usdValue === null || usdValue < minUsd) continue

        const quoteDecimals = quoteIsToken0 ? info.decimals0 : info.decimals1
        const tokenDecimals = quoteIsToken0 ? info.decimals1 : info.decimals0
        const quoteAmount = Math.abs(Number(quoteRaw)) / 10 ** quoteDecimals
        const tokenAmount = Math.abs(Number(tokenRaw)) / 10 ** tokenDecimals

        const [tokenMeta, quoteMeta] = await Promise.all([
          ctx.tokens.get(entry.token),
          ctx.tokens.get(entry.quoteToken),
        ])
        const trader = (log.args.recipient as Address | undefined) ?? (log.args.sender as Address)

        events.push({
          id: eventId('whale_trade', log.transactionHash, log.logIndex),
          kind: 'whale_trade',
          launchpad: entry.launchpad,
          token: entry.token,
          symbol: tokenMeta.symbol,
          name: tokenMeta.name,
          actor: getAddress(trader),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestampMs: null,
          usdValue,
          explorer: links(base, entry.token, trader, log.transactionHash, entry.pool),
          pool: entry.pool,
          quoteToken: entry.quoteToken,
          quoteSymbol: quoteMeta.symbol ?? 'quote',
          // The memecoin left the pool (negative delta) means the trader bought it.
          side: tokenRaw < 0n ? 'buy' : 'sell',
          tokenAmount,
          quoteAmount,
          price: tokenAmount > 0 ? quoteAmount / tokenAmount : 0,
          feeTier: info.fee,
        })
      }
      return stampTimes(ctx, events)
    },
  }
}

/** Every launchpad an event source can attribute an event to. */
export const SUPPORTED_LAUNCHPADS: readonly Launchpad[] = ['noxa', 'odyssey']
