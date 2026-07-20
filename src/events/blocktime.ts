import type { HoodClient } from 'hoodchain'

/** Cached block-timestamp reader. */
export interface BlockTimeReader {
  /**
   * Timestamp of `blockNumber` in ms, or `null` when it could not be read
   * within the caller's budget. Events carry `timestampMs: null` in that case
   * rather than a fabricated "now".
   */
  get(blockNumber: bigint): Promise<number | null>
  /**
   * Resolve timestamps for a set of blocks, bounded by `maxLookups`. Blocks
   * past the budget resolve to `null`: a backfill of a million blocks must not
   * turn into a million `eth_getBlockByNumber` calls.
   */
  getMany(blocks: readonly bigint[], maxLookups: number): Promise<Map<bigint, number | null>>
}

/** Build a block-timestamp reader with a bounded LRU cache. */
export function createBlockTimeReader(client: HoodClient, maxEntries = 2_000): BlockTimeReader {
  const cache = new Map<string, number>()

  function remember(block: bigint, ts: number): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(block.toString(), ts)
  }

  async function get(blockNumber: bigint): Promise<number | null> {
    const hit = cache.get(blockNumber.toString())
    if (hit !== undefined) return hit
    try {
      const block = await client.public.getBlock({ blockNumber, includeTransactions: false })
      const ms = Number(block.timestamp) * 1000
      remember(blockNumber, ms)
      return ms
    } catch {
      return null
    }
  }

  return {
    get,
    async getMany(blocks: readonly bigint[], maxLookups: number): Promise<Map<bigint, number | null>> {
      const unique = [...new Set(blocks.map((b) => b.toString()))].map((b) => BigInt(b))
      const out = new Map<bigint, number | null>()
      let budget = maxLookups
      for (const block of unique) {
        const cached = cache.get(block.toString())
        if (cached !== undefined) {
          out.set(block, cached)
          continue
        }
        if (budget <= 0) {
          out.set(block, null)
          continue
        }
        budget -= 1
        out.set(block, await get(block))
      }
      return out
    },
  }
}
