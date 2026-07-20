import type { Address } from 'viem'

/**
 * Resilient log fetching for Robinhood Chain's public RPC.
 *
 * Two behaviours of the public endpoint drive this helper, both measured
 * against `https://rpc.mainnet.chain.robinhood.com` while building this
 * package:
 *
 * 1. **There is no block-range cap, but there is a 10,000-log result cap.**
 *    A query spanning millions of blocks succeeds if it is selective enough
 *    (the three Odyssey factories return every log they ever emitted in one
 *    call); a query spanning 2,000 blocks fails with
 *    `logs matched by query exceeds limit of 10000` if it is not (a topic-only
 *    Uniswap v3 `Swap` query does). Fixed-size range chunking therefore
 *    cannot guarantee success, so {@link fetchLogRange} bisects the range on
 *    that specific error until each half fits.
 * 2. **It rate limits bursts with `Too Many Requests`.** Those are retried
 *    with exponential backoff rather than surfaced, because a retryable 429
 *    must never advance a caller's block cursor.
 */

/** Options for {@link fetchLogRange}. */
export interface FetchLogRangeOptions {
  /**
   * Smallest range the bisector will produce. A single block that still
   * overflows the result cap throws, because there is nothing left to split.
   * @defaultValue `1n`
   */
  minSpan?: bigint
  /** Retries for rate-limit and transient transport errors. @defaultValue `5` */
  retries?: number
  /** Base backoff in ms, doubled per attempt. @defaultValue `500` */
  backoffMs?: number
  /** Sleep injection point for tests. @defaultValue a real timer */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `true` when the RPC rejected the query for returning too many logs. */
export function isResultTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /exceeds limit|too many results|response size exceeded|query returned more than/i.test(message)
}

/** `true` when the error is a transient rate limit or timeout worth retrying. */
export function isRetryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /too many requests|rate limit|timed out|timeout|429|503|502|ECONNRESET|socket hang up|fetch failed/i.test(
    message,
  )
}

/**
 * Fetch logs for `[from, to]` inclusive through `fetcher`, bisecting the range
 * when the RPC reports too many results and retrying transient failures.
 *
 * @throws the underlying error when a single block still overflows the result
 * cap, or when retries are exhausted. Callers must treat a throw as "range not
 * processed" and leave their cursor untouched.
 *
 * @example
 * ```ts
 * const logs = await fetchLogRange(
 *   (from, to) => hood.public.getLogs({ address: factory, event, fromBlock: from, toBlock: to }),
 *   0n,
 *   await hood.public.getBlockNumber(),
 * )
 * ```
 */
export async function fetchLogRange<T>(
  fetcher: (from: bigint, to: bigint) => Promise<readonly T[]>,
  from: bigint,
  to: bigint,
  options: FetchLogRangeOptions = {},
): Promise<T[]> {
  const minSpan = options.minSpan ?? 1n
  const retries = options.retries ?? 5
  const backoffMs = options.backoffMs ?? 500
  const sleep = options.sleep ?? defaultSleep

  const run = async (lo: bigint, hi: bigint): Promise<T[]> => {
    let attempt = 0
    for (;;) {
      try {
        return [...(await fetcher(lo, hi))]
      } catch (error) {
        if (isResultTooLarge(error)) {
          const span = hi - lo
          if (span < minSpan || span === 0n) throw error
          const mid = lo + span / 2n
          const left = await run(lo, mid)
          const right = await run(mid + 1n, hi)
          return [...left, ...right]
        }
        if (isRetryableRpcError(error) && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt)
          attempt += 1
          continue
        }
        throw error
      }
    }
  }

  if (to < from) return []
  return run(from, to)
}

/**
 * Split a list of addresses into query-sized batches. The RPC accepts long
 * address arrays, but batching keeps any single response under the result cap
 * and keeps one failing batch from invalidating the whole set.
 */
export function batchAddresses(addresses: readonly Address[], size = 200): Address[][] {
  const batches: Address[][] = []
  for (let i = 0; i < addresses.length; i += size) {
    batches.push(addresses.slice(i, i + size) as Address[])
  }
  return batches
}
