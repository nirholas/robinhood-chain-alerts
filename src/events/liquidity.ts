import { formatUnits, type Address } from 'viem'
import { USDG_DECIMALS, erc20Abi, type HoodClient } from 'hoodchain'
import type { PriceOracle } from './pricing.js'
import { quoteTokens } from './pricing.js'
import type { PoolRegistry } from './registry.js'

/**
 * Pool liquidity in USD, measured the only way that is honest without an
 * indexer: the pool's live balance of its quote token, doubled.
 *
 * A Uniswap v3 pool holds real balances of both sides. The quote side (WETH
 * or USDG) is the side with a known USD value, so `quoteBalance * 2` is the
 * standard two-sided TVL approximation and it is exactly what a trader means
 * by "how much liquidity is in there". For concentrated positions this is the
 * *total* reserve rather than the reserve inside the active tick, which is
 * documented rather than papered over: min/max liquidity rules filter on this
 * number, so subscribers should read it as pool reserves, not tradeable depth.
 */
export interface LiquidityReader {
  /** USD liquidity of a specific pool, or `null` when the quote side is unpriceable. */
  poolLiquidityUsd(pool: Address, quoteToken: Address): Promise<number | null>
  /**
   * Best-known USD liquidity for a token: the largest of its recorded pools.
   * `null` when the token has no recorded pool (an Odyssey token still on its
   * bonding curve, for example).
   */
  tokenLiquidityUsd(token: Address): Promise<number | null>
}

/** Options for {@link createLiquidityReader}. */
export interface LiquidityReaderOptions {
  /** Cache lifetime for a pool's USD liquidity, in ms. @defaultValue `60_000` */
  ttlMs?: number
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

interface CacheEntry {
  value: number | null
  at: number
}

/** Build a caching liquidity reader over live pool balances. */
export function createLiquidityReader(
  client: HoodClient,
  oracle: PriceOracle,
  registry: PoolRegistry,
  options: LiquidityReaderOptions = {},
): LiquidityReader {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  const { weth, usdg } = quoteTokens(client)

  async function readPool(pool: Address, quoteToken: Address): Promise<number | null> {
    const quote = quoteToken.toLowerCase()
    if (quote !== weth.toLowerCase() && quote !== usdg.toLowerCase()) return null
    const balance = await client.public.readContract({
      address: quoteToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool],
    })
    if (quote === usdg.toLowerCase()) {
      return Number(formatUnits(balance, USDG_DECIMALS)) * 2
    }
    const usd = await oracle.weiToUsd(balance)
    return usd === null ? null : usd * 2
  }

  async function poolLiquidityUsd(pool: Address, quoteToken: Address): Promise<number | null> {
    const key = pool.toLowerCase()
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    let value: number | null
    try {
      value = await readPool(pool, quoteToken)
    } catch {
      // A failed read must not be reported as zero liquidity: that would
      // silently satisfy every `maxLiquidityUsd` rule. Unknown stays unknown.
      value = null
    }
    cache.set(key, { value, at: now() })
    return value
  }

  return {
    poolLiquidityUsd,
    async tokenLiquidityUsd(token: Address): Promise<number | null> {
      const pools = await registry.poolsFor(token)
      if (pools.length === 0) return null
      const values = await Promise.all(
        pools.map((entry) => poolLiquidityUsd(entry.pool, entry.quoteToken)),
      )
      const known = values.filter((v): v is number => v !== null)
      return known.length === 0 ? null : Math.max(...known)
    },
  }
}
