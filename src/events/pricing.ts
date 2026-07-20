import { formatUnits, type Address } from 'viem'
import {
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  USDG_DECIMALS,
  quoteSwap,
  type HoodClient,
} from 'hoodchain'

/**
 * USD valuation for alert events.
 *
 * There is no hardcoded price anywhere in this package. Every dollar figure
 * comes from live chain state:
 *
 * - **USDG legs are the unit of account.** USDG is Paxos' Global Dollar, a
 *   fully reserved 1:1 USD stablecoin with 6 decimals. A USDG leg of a trade
 *   is its own USD value, no oracle needed.
 * - **ETH legs are priced through the chain's own Uniswap v3 liquidity.** The
 *   oracle asks `hoodchain`'s `quoteSwap` for the real output of selling 1
 *   WETH into USDG across every fee tier and two-hop route, and takes the best
 *   route's output as the ETH/USD rate. That is the price a trader would
 *   actually get, sourced from the same pools the alerts watch.
 * - **Anything else is `null`.** A memecoin/memecoin pool with no USDG or WETH
 *   leg has no honest USD value from on-chain data alone, so the event carries
 *   `usdValue: null` and min-USD rules simply do not match it.
 *
 * Rates are cached for a short TTL so a burst of events in one block does not
 * re-quote the router once per event.
 */

/** A source of USD rates for the two priceable legs. */
export interface PriceOracle {
  /**
   * USD per 1 ETH, or `null` when no WETH/USDG route has liquidity right now.
   * Never throws: a quote failure degrades to `null`, which downgrades USD
   * filters rather than dropping the alert pipeline.
   */
  ethUsd(): Promise<number | null>
  /** Convert a raw wei amount to USD, or `null` when the rate is unavailable. */
  weiToUsd(wei: bigint): Promise<number | null>
  /** Convert a raw USDG amount (6 decimals) to USD. Always available. */
  usdgToUsd(atomic: bigint): number
}

/** Options for {@link createPriceOracle}. */
export interface PriceOracleOptions {
  /**
   * How long a quoted ETH/USD rate stays fresh, in milliseconds.
   * @defaultValue `30_000`
   */
  ttlMs?: number
  /**
   * Probe size used to quote WETH into USDG. Larger sizes are less sensitive
   * to a thin tick but need deeper liquidity to fill.
   * @defaultValue `1` ETH
   */
  probeWei?: bigint
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

/** WETH and USDG for the client's network. */
export function quoteTokens(client: HoodClient): { weth: Address; usdg: Address } {
  return client.network === 'testnet'
    ? { weth: TESTNET_ADDRESSES.weth, usdg: TESTNET_ADDRESSES.usdg }
    : { weth: MAINNET_ADDRESSES.weth, usdg: MAINNET_ADDRESSES.usdg }
}

/**
 * Build a caching ETH/USD oracle backed by real Uniswap v3 quotes.
 *
 * @example
 * ```ts
 * import { createHoodClient } from 'hoodchain'
 * import { createPriceOracle } from 'hood-alerts/events'
 *
 * const hood = createHoodClient()
 * const oracle = createPriceOracle(hood)
 * console.log('ETH/USD from chain liquidity:', await oracle.ethUsd())
 * ```
 */
export function createPriceOracle(client: HoodClient, options: PriceOracleOptions = {}): PriceOracle {
  const ttlMs = options.ttlMs ?? 30_000
  const probeWei = options.probeWei ?? 10n ** 18n
  const now = options.now ?? Date.now
  const { weth, usdg } = quoteTokens(client)

  let cached: number | null = null
  let cachedAt = 0
  let inflight: Promise<number | null> | null = null

  async function refresh(): Promise<number | null> {
    try {
      const quote = await quoteSwap(client, { tokenIn: weth, tokenOut: usdg, amountIn: probeWei })
      const usdgOut = Number(formatUnits(quote.amountOut, USDG_DECIMALS))
      const ethIn = Number(formatUnits(probeWei, 18))
      const rate = ethIn > 0 ? usdgOut / ethIn : 0
      cached = rate > 0 ? rate : null
    } catch {
      // No route or no liquidity right now. Report "unknown", never a guess.
      cached = null
    }
    cachedAt = now()
    return cached
  }

  async function ethUsd(): Promise<number | null> {
    if (cachedAt !== 0 && now() - cachedAt < ttlMs) return cached
    // Coalesce concurrent refreshes so a block full of events makes one quote.
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    ethUsd,
    async weiToUsd(wei: bigint): Promise<number | null> {
      const rate = await ethUsd()
      if (rate === null) return null
      return Number(formatUnits(wei < 0n ? -wei : wei, 18)) * rate
    },
    usdgToUsd(atomic: bigint): number {
      return Number(formatUnits(atomic < 0n ? -atomic : atomic, USDG_DECIMALS))
    },
  }
}

/**
 * A fixed-rate oracle. Useful when an operator already has a trusted ETH/USD
 * feed and wants alerts to agree with it, and for deterministic tests.
 */
export function createStaticPriceOracle(ethUsdRate: number | null): PriceOracle {
  return {
    async ethUsd() {
      return ethUsdRate
    },
    async weiToUsd(wei: bigint) {
      if (ethUsdRate === null) return null
      return Number(formatUnits(wei < 0n ? -wei : wei, 18)) * ethUsdRate
    },
    usdgToUsd(atomic: bigint) {
      return Number(formatUnits(atomic < 0n ? -atomic : atomic, USDG_DECIMALS))
    },
  }
}
