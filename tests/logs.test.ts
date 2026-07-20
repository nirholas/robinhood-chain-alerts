import { describe, expect, it } from 'vitest'
import {
  batchAddresses,
  fetchLogRange,
  isResultTooLarge,
  isRetryableRpcError,
} from '../src/events/logs.js'
import { addr, recordingSleep } from './helpers.js'

/**
 * The public RPC's two failure modes, reproduced exactly as it reports them.
 * The error strings below are the ones `rpc.mainnet.chain.robinhood.com`
 * returns, verified against the live endpoint while building this package.
 */

const TOO_LARGE = 'logs matched by query exceeds limit of 10000'
const RATE_LIMITED = 'Too Many Requests'

describe('error classification', () => {
  it('recognises the result-cap error', () => {
    expect(isResultTooLarge(new Error(TOO_LARGE))).toBe(true)
    expect(isResultTooLarge(new Error('query returned more than 10000 results'))).toBe(true)
    expect(isResultTooLarge(new Error('nonce too low'))).toBe(false)
  })

  it('recognises transient transport failures', () => {
    for (const message of [RATE_LIMITED, 'log query timed out', 'fetch failed', 'socket hang up', 'HTTP 503']) {
      expect(isRetryableRpcError(new Error(message))).toBe(true)
    }
    expect(isRetryableRpcError(new Error('execution reverted'))).toBe(false)
  })
})

describe('fetchLogRange', () => {
  it('returns logs from a single successful call', async () => {
    const logs = await fetchLogRange(async (from, to) => [`${from}-${to}`], 0n, 100n)
    expect(logs).toEqual(['0-100'])
  })

  it('returns nothing for an inverted range instead of querying', async () => {
    let calls = 0
    const logs = await fetchLogRange(async () => {
      calls += 1
      return []
    }, 10n, 5n)
    expect(logs).toEqual([])
    expect(calls).toBe(0)
  })

  it('bisects on the result cap until each half fits', async () => {
    const ranges: string[] = []
    const logs = await fetchLogRange(
      async (from, to) => {
        ranges.push(`${from}-${to}`)
        // Anything wider than 25 blocks overflows, exactly as a busy range does.
        if (to - from > 25n) throw new Error(TOO_LARGE)
        return [`${from}-${to}`]
      },
      0n,
      99n,
    )

    expect(ranges[0]).toBe('0-99')
    expect(logs).toEqual(['0-24', '25-49', '50-74', '75-99'])
  })

  it('preserves log order across a bisection', async () => {
    const logs = await fetchLogRange(
      async (from, to) => {
        if (to - from > 1n) throw new Error(TOO_LARGE)
        const block: number[] = []
        for (let n = from; n <= to; n += 1n) block.push(Number(n))
        return block
      },
      0n,
      7n,
    )
    expect(logs).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('throws when a single block still overflows, rather than looping forever', async () => {
    await expect(
      fetchLogRange(async () => {
        throw new Error(TOO_LARGE)
      }, 5n, 5n),
    ).rejects.toThrow(TOO_LARGE)
  })

  it('retries a rate limit with exponential backoff and then succeeds', async () => {
    const sleep = recordingSleep()
    let attempts = 0
    const logs = await fetchLogRange(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error(RATE_LIMITED)
        return ['ok']
      },
      0n,
      10n,
      { sleep, backoffMs: 100 },
    )

    expect(logs).toEqual(['ok'])
    expect(sleep.waits).toEqual([100, 200])
  })

  it('gives up after the retry budget so the caller can leave its cursor alone', async () => {
    const sleep = recordingSleep()
    await expect(
      fetchLogRange(
        async () => {
          throw new Error(RATE_LIMITED)
        },
        0n,
        10n,
        { sleep, retries: 2, backoffMs: 10 },
      ),
    ).rejects.toThrow(RATE_LIMITED)
    expect(sleep.waits).toHaveLength(2)
  })

  it('does not retry a non-transient error', async () => {
    const sleep = recordingSleep()
    await expect(
      fetchLogRange(
        async () => {
          throw new Error('invalid params')
        },
        0n,
        10n,
        { sleep },
      ),
    ).rejects.toThrow('invalid params')
    expect(sleep.waits).toEqual([])
  })
})

describe('batchAddresses', () => {
  it('splits an address list into query-sized batches', () => {
    const addresses = Array.from({ length: 45 }, (_unused, index) => addr(index + 1))
    const batches = batchAddresses(addresses, 20)
    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5])
    expect(batches.flat()).toEqual(addresses)
  })

  it('returns nothing for an empty list', () => {
    expect(batchAddresses([], 10)).toEqual([])
  })
})
