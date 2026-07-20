import { getAddress, type Address } from 'viem'
import { erc20Abi, type HoodClient } from 'hoodchain'

/** ERC-20 display metadata, with `null` for anything the contract does not answer. */
export interface TokenMeta {
  address: Address
  symbol: string | null
  name: string | null
  /** Decimals, defaulting to 18 when the call reverts (the launchpad standard). */
  decimals: number
}

/** Cached reader for ERC-20 display metadata. */
export interface TokenMetaReader {
  get(token: Address): Promise<TokenMeta>
  /** Prime the cache without a network round trip (used by the service store). */
  prime(meta: TokenMeta): void
}

/**
 * Build a token metadata reader.
 *
 * Metadata is immutable in practice for launchpad tokens, so entries are
 * cached for the process lifetime. A token whose `symbol()`/`name()` revert
 * (some minimal proxies omit them) resolves to `null` fields rather than
 * throwing, because a missing symbol must never drop an alert.
 */
export function createTokenMetaReader(client: HoodClient, maxEntries = 5_000): TokenMetaReader {
  const cache = new Map<string, TokenMeta>()
  const inflight = new Map<string, Promise<TokenMeta>>()

  function remember(meta: TokenMeta): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(meta.address.toLowerCase(), meta)
  }

  async function load(token: Address): Promise<TokenMeta> {
    const results = await client.public.multicall({
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'symbol' },
        { address: token, abi: erc20Abi, functionName: 'name' },
        { address: token, abi: erc20Abi, functionName: 'decimals' },
      ],
      allowFailure: true,
    })
    const [symbolResult, nameResult, decimalsResult] = results
    const meta: TokenMeta = {
      address: getAddress(token),
      symbol:
        symbolResult && symbolResult.status === 'success' ? String(symbolResult.result) : null,
      name: nameResult && nameResult.status === 'success' ? String(nameResult.result) : null,
      decimals:
        decimalsResult && decimalsResult.status === 'success' ? Number(decimalsResult.result) : 18,
    }
    remember(meta)
    return meta
  }

  return {
    async get(token: Address): Promise<TokenMeta> {
      const key = token.toLowerCase()
      const hit = cache.get(key)
      if (hit) return hit
      const pending = inflight.get(key)
      if (pending) return pending
      const promise = load(token)
        .catch((): TokenMeta => {
          // A dead RPC must not break event construction: fall back to a
          // metadata-free record. The address is always enough to alert on.
          const fallback: TokenMeta = { address: getAddress(token), symbol: null, name: null, decimals: 18 }
          remember(fallback)
          return fallback
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, promise)
      return promise
    },
    prime(meta: TokenMeta): void {
      remember(meta)
    },
  }
}
