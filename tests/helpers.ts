import { getAddress, type Address, type Hash } from 'viem'
import type {
  CurveTradeEvent,
  GraduationEvent,
  LaunchEvent,
  WhaleTradeEvent,
} from '../src/events/types.js'
import type { FetchLike, FetchLikeResponse } from '../src/notifiers/types.js'

/**
 * Test doubles.
 *
 * Addresses here are synthetic (`0x…01`, `0x…02`) and never a real mainnet
 * contract, so no test can be mistaken for a claim about a real token, and no
 * assertion silently depends on live chain state.
 */

/** A synthetic, checksummed address from a small integer. */
export function addr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, '0')}` as Address)
}

/** A synthetic transaction hash from a small integer. */
export function hash(n: number): Hash {
  return `0x${n.toString(16).padStart(64, '0')}` as Hash
}

const explorer = 'https://robinhoodchain.blockscout.com'

/** Shorthand overrides accepted by every event factory. */
export type EventOverrides<T> = Partial<T> & { block?: bigint }

function baseFields(overrides: { token?: Address; actor?: Address; block?: bigint; logIndex?: number }) {
  const token = overrides.token ?? addr(1)
  const actor = overrides.actor ?? addr(2)
  const blockNumber = overrides.block ?? 1_000n
  const logIndex = overrides.logIndex ?? 0
  const transactionHash = hash(Number(blockNumber))
  return {
    token,
    actor,
    blockNumber,
    logIndex,
    transactionHash,
    explorer: {
      tx: `${explorer}/tx/${transactionHash}`,
      token: `${explorer}/token/${token}`,
      actor: `${explorer}/address/${actor}`,
    },
  }
}

/** Build a launch event. */
export function launchEvent(overrides: EventOverrides<LaunchEvent> = {}): LaunchEvent {
  const base = baseFields(overrides)
  return {
    id: `launch:${base.transactionHash}:${base.logIndex}`,
    kind: 'launch',
    launchpad: 'noxa',
    symbol: 'TEST',
    name: 'Test Token',
    timestampMs: 1_700_000_000_000,
    usdValue: 2_500,
    pool: addr(9),
    pairToken: addr(8),
    initialBuyAmount: 10n ** 18n,
    positionId: 42n,
    instantListing: true,
    ...base,
    ...overrides,
  } as LaunchEvent
}

/** Build a bonding-curve trade event. */
export function curveTradeEvent(overrides: EventOverrides<CurveTradeEvent> = {}): CurveTradeEvent {
  const base = baseFields(overrides)
  return {
    id: `curve_trade:${base.transactionHash}:${base.logIndex}`,
    kind: 'curve_trade',
    launchpad: 'odyssey',
    symbol: 'CURVE',
    name: 'Curve Token',
    timestampMs: 1_700_000_000_000,
    usdValue: 900,
    side: 'buy',
    tokenAmount: 5n * 10n ** 18n,
    quoteAmountWei: 3n * 10n ** 17n,
    feeWei: 10n ** 15n,
    virtualQuoteWei: 10n ** 19n,
    virtualTokenAmount: 10n ** 24n,
    priceEth: 0.06,
    ...base,
    ...overrides,
  } as CurveTradeEvent
}

/** Build a graduation event. */
export function graduationEvent(overrides: EventOverrides<GraduationEvent> = {}): GraduationEvent {
  const base = baseFields(overrides)
  return {
    id: `graduation:${base.transactionHash}:${base.logIndex}`,
    kind: 'graduation',
    launchpad: 'odyssey',
    symbol: 'GRAD',
    name: 'Graduated Token',
    timestampMs: 1_700_000_000_000,
    usdValue: 12_000,
    pool: addr(9),
    positionId: 77n,
    liquidity: 10n ** 18n,
    tokenUsed: 10n ** 24n,
    quoteUsed: 12_000_000_000n,
    ...base,
    ...overrides,
  } as GraduationEvent
}

/** Build a whale trade event. */
export function whaleTradeEvent(overrides: EventOverrides<WhaleTradeEvent> = {}): WhaleTradeEvent {
  const base = baseFields(overrides)
  return {
    id: `whale_trade:${base.transactionHash}:${base.logIndex}`,
    kind: 'whale_trade',
    launchpad: 'noxa',
    symbol: 'WHALE',
    name: 'Whale Token',
    timestampMs: 1_700_000_000_000,
    usdValue: 25_000,
    pool: addr(9),
    quoteToken: addr(8),
    quoteSymbol: 'USDG',
    side: 'buy',
    tokenAmount: 1_000_000,
    quoteAmount: 25_000,
    price: 0.025,
    feeTier: 10_000,
    ...base,
    ...overrides,
  } as WhaleTradeEvent
}

/** One scripted HTTP response for {@link scriptedFetch}. */
export interface ScriptedResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

/** A recorded HTTP request. */
export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A `fetch` double that replays a scripted sequence and records every request.
 * This is a test double of the HTTP interface, not fake product data: the
 * bodies are exactly the shapes the Telegram and Discord APIs document.
 */
export function scriptedFetch(responses: ScriptedResponse[]): FetchLike & {
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  let index = 0

  const impl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body === undefined ? null : JSON.parse(init.body),
    })
    const scripted = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!scripted) throw new Error('scriptedFetch: no response scripted')
    const headers = scripted.headers ?? {}
    const response: FetchLikeResponse = {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      text: async () => (scripted.body === undefined ? '' : JSON.stringify(scripted.body)),
    }
    return response
  }) as FetchLike & { requests: RecordedRequest[] }

  impl.requests = requests
  return impl
}

/** A `fetch` double that always throws, for transport-failure paths. */
export function throwingFetch(message = 'network down'): FetchLike {
  return async () => {
    throw new Error(message)
  }
}

/** A sleep double that records the requested waits instead of waiting. */
export function recordingSleep(): ((ms: number) => Promise<void>) & { waits: number[] } {
  const waits: number[] = []
  const sleep = (async (ms: number) => {
    waits.push(ms)
  }) as ((ms: number) => Promise<void>) & { waits: number[] }
  sleep.waits = waits
  return sleep
}

/**
 * A sleep double that advances a fake clock instead of waiting, so a test sees
 * the same time progression a real deployment would.
 */
export function advancingSleep(clock: { now: () => number; advance(ms: number): void }): ((
  ms: number,
) => Promise<void>) & { waits: number[] } {
  const waits: number[] = []
  const sleep = (async (ms: number) => {
    waits.push(ms)
    clock.advance(ms)
  }) as ((ms: number) => Promise<void>) & { waits: number[] }
  sleep.waits = waits
  return sleep
}

/** A controllable clock. */
export function fakeClock(startMs = 1_700_000_000_000): { now: () => number; advance(ms: number): void } {
  let current = startMs
  return {
    now: () => current,
    advance(ms: number): void {
      current += ms
    },
  }
}
