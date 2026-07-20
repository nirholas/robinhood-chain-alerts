import { getAddress, type Address } from 'viem'
import type { Launchpad } from './types.js'

/**
 * A memecoin pool the whale watcher tracks.
 *
 * Why a registry exists at all: chain-wide `Swap` queries are not viable on
 * Robinhood Chain. A topic-only query for the Uniswap v3 `Swap` signature
 * overflows the RPC's 10,000-log result cap in well under 2,000 blocks (the
 * chain produces a block roughly every 100-130ms and is busy). The whale
 * source therefore watches an explicit, address-filtered *active pool set*
 * assembled from launchpad activity: NOXA pools are known at launch, Odyssey
 * pools are known at graduation.
 */
export interface PoolEntry {
  pool: Address
  /** The memecoin side of the pool. */
  token: Address
  /** The quote side (WETH or USDG). */
  quoteToken: Address
  launchpad: Launchpad
  /** Block the pool became known (launch for NOXA, graduation for Odyssey). */
  createdBlock: bigint
}

/** Storage for known memecoin pools and token origins. */
export interface PoolRegistry {
  /** Record (or update) a pool. Idempotent. */
  record(entry: PoolEntry): Promise<void>
  /**
   * The pools to watch for whale trades, newest first, capped at `limit`.
   * `pinned` tokens (subscriber watchlists) are always included regardless of
   * age, because a watchlist alert that silently ages out would be a lie.
   */
  active(limit: number, pinned?: readonly Address[]): Promise<PoolEntry[]>
  /** Which launchpad a token came from, or `null` if never seen. */
  originOf(token: Address): Promise<Launchpad | null>
  /** Every pool recorded for a token. */
  poolsFor(token: Address): Promise<PoolEntry[]>
  /** Total pools recorded, for `/metrics`. */
  size(): Promise<number>
}

/**
 * In-memory pool registry. Correct and dependency-free, but it starts empty
 * on every process start, so the service uses the SQLite-backed registry from
 * `hood-alerts/service` instead. This one is the right choice for scripts,
 * examples and tests.
 */
export function createMemoryPoolRegistry(entries: readonly PoolEntry[] = []): PoolRegistry {
  const pools = new Map<string, PoolEntry>()
  for (const entry of entries) pools.set(entry.pool.toLowerCase(), entry)

  return {
    async record(entry: PoolEntry): Promise<void> {
      pools.set(entry.pool.toLowerCase(), {
        ...entry,
        pool: getAddress(entry.pool),
        token: getAddress(entry.token),
        quoteToken: getAddress(entry.quoteToken),
      })
    },
    async active(limit: number, pinned: readonly Address[] = []): Promise<PoolEntry[]> {
      const pinnedSet = new Set(pinned.map((a) => a.toLowerCase()))
      const all = [...pools.values()].sort((a, b) => (a.createdBlock > b.createdBlock ? -1 : 1))
      const isPinned = (entry: PoolEntry): boolean => pinnedSet.has(entry.token.toLowerCase())
      // Pinned pools are additional to the limit, not counted against it: a
      // watchlist alert that aged out of the window would be a silent lie.
      const picked = all.filter(isPinned)
      let recent = 0
      for (const entry of all) {
        if (recent >= limit) break
        if (isPinned(entry)) continue
        picked.push(entry)
        recent += 1
      }
      return picked
    },
    async originOf(token: Address): Promise<Launchpad | null> {
      const key = token.toLowerCase()
      for (const entry of pools.values()) {
        if (entry.token.toLowerCase() === key) return entry.launchpad
      }
      return null
    },
    async poolsFor(token: Address): Promise<PoolEntry[]> {
      const key = token.toLowerCase()
      return [...pools.values()].filter((entry) => entry.token.toLowerCase() === key)
    },
    async size(): Promise<number> {
      return pools.size
    },
  }
}
