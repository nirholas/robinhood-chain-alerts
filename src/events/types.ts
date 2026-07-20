import type { Address, Hash } from 'viem'

/**
 * The normalized alert event taxonomy for Robinhood Chain memecoins.
 *
 * Two launchpads run on mainnet (chain 4663) and they have genuinely
 * different lifecycles. The taxonomy models that difference instead of
 * pretending they are the same product:
 *
 * - **NOXA** (`fun.noxa.fi/robinhood`) is an *instant* launcher. One
 *   transaction deploys the ERC-20, creates a Uniswap v3 pool, seeds
 *   single-sided liquidity and locks the LP NFT. There is no bonding curve,
 *   so NOXA emits `launch` and (through its pool) `whale_trade`, and it can
 *   never emit `curve_trade` or `graduation`.
 * - **The Odyssey** (`theodyssey.fun`) is a pump.fun-style native-ETH bonding
 *   curve with virtual reserves. It emits `launch` when a curve opens,
 *   `curve_trade` for every buy/sell on the curve, and `graduation` when the
 *   curve fills and liquidity migrates to a locked Uniswap v3 pool. After
 *   graduation its tokens also produce `whale_trade` from the migrated pool.
 *
 * A `graduation` alert therefore covers The Odyssey only. Claiming NOXA
 * "graduations" would be describing an event that does not exist on chain.
 */

/** Which launchpad an event originated from. */
export type Launchpad = 'noxa' | 'odyssey'

/** The kinds of alert this package emits. */
export type AlertEventKind = 'launch' | 'curve_trade' | 'graduation' | 'whale_trade'

/** Buy or sell, from the trader's perspective. */
export type TradeSide = 'buy' | 'sell'

/** Explorer deep links attached to every event. */
export interface ExplorerLinks {
  /** The transaction that produced the event. */
  tx: string
  /** The token contract. */
  token: string
  /** The actor (deployer or trader). */
  actor: string
  /** The Uniswap v3 pool, when the event has one. */
  pool?: string
}

/** Fields every alert event carries. */
export interface AlertEventBase {
  /**
   * Stable, content-addressed identity for this event: `kind:txHash:logIndex`.
   * Reprocessing the same block range regenerates the identical id, which is
   * what makes the delivery dedupe table work across restarts and reorg
   * re-reads.
   */
  id: string
  kind: AlertEventKind
  launchpad: Launchpad
  /** The memecoin the event is about. */
  token: Address
  /** Token symbol read from the ERC-20, or `null` when the call reverts. */
  symbol: string | null
  /** Token name read from the ERC-20, or `null` when the call reverts. */
  name: string | null
  /** The wallet responsible: the deployer for launches, the trader for trades. */
  actor: Address
  blockNumber: bigint
  logIndex: number
  transactionHash: Hash
  /**
   * Block timestamp in milliseconds since epoch, or `null` when the event was
   * decoded without a block fetch (the source fills it whenever available).
   */
  timestampMs: number | null
  /**
   * USD value of the event, or `null` when it cannot be derived from a real
   * price source. Never guessed: launches carry the seeded/initial-buy value,
   * trades carry the traded notional, and `null` means "no USDG or WETH leg to
   * price against", which rules treat as "does not satisfy a min-USD filter".
   */
  usdValue: number | null
  explorer: ExplorerLinks
}

/**
 * A new token launch.
 *
 * NOXA: decoded from `TokenLaunched` on the launch factory. `pool` is present
 * immediately and `initialBuyAmount` is the deployer's own first buy.
 * Odyssey: decoded from `TokenCreated` on a bonding-curve factory. `pool` is
 * `null` because the curve holds the liquidity until graduation.
 */
export interface LaunchEvent extends AlertEventBase {
  kind: 'launch'
  /** The Uniswap v3 pool, or `null` for an Odyssey token still on its curve. */
  pool: Address | null
  /** The quote token of the pool (NOXA only, `null` on Odyssey). */
  pairToken: Address | null
  /** Raw initial buy in the pair token's units (NOXA), else `0n`. */
  initialBuyAmount: bigint
  /**
   * The Uniswap v3 LP position NFT minted for this launch (NOXA), or `null`
   * when the launchpad did not mint one at launch time (every Odyssey token,
   * whose LP appears at graduation). Reputation rules read its owner to prove
   * the LP is locked.
   */
  positionId: bigint | null
  /**
   * `true` when this launchpad lists instantly with no bonding curve, so no
   * `graduation` event will ever follow. Always `true` for NOXA. For Odyssey
   * it is `true` only for launches from the instant factory variant.
   */
  instantListing: boolean
}

/**
 * A bonding-curve buy or sell. The Odyssey only: NOXA has no curve.
 * Decoded from `Traded` on an Odyssey factory.
 */
export interface CurveTradeEvent extends AlertEventBase {
  kind: 'curve_trade'
  launchpad: 'odyssey'
  side: TradeSide
  /** Token amount bought or sold, raw (18 decimals). */
  tokenAmount: bigint
  /** Native ETH paid or received, in wei. */
  quoteAmountWei: bigint
  /** Protocol fee taken on this trade, in wei. */
  feeWei: bigint
  /** Curve virtual quote reserve after the trade, in wei. */
  virtualQuoteWei: bigint
  /** Curve virtual token reserve after the trade, raw. */
  virtualTokenAmount: bigint
  /** Price of one token in ETH implied by this fill, or `null` for a zero-size fill. */
  priceEth: number | null
}

/**
 * A curve that filled and migrated to a locked Uniswap v3 pool.
 * The Odyssey only. Decoded from `PoolMigrated`.
 */
export interface GraduationEvent extends AlertEventBase {
  kind: 'graduation'
  launchpad: 'odyssey'
  /** The Uniswap v3 pool liquidity migrated into. */
  pool: Address
  /** The position manager token id holding the migrated liquidity. */
  positionId: bigint
  /** Uniswap v3 liquidity units minted at migration. */
  liquidity: bigint
  /** Token side used to seed the pool, raw. */
  tokenUsed: bigint
  /** Quote side used to seed the pool, raw (6 decimals when the quote is USDG). */
  quoteUsed: bigint
}

/**
 * A Uniswap v3 swap on a memecoin pool above the configured USD threshold.
 * Both launchpads produce these: NOXA from block one, Odyssey after
 * graduation.
 */
export interface WhaleTradeEvent extends AlertEventBase {
  kind: 'whale_trade'
  pool: Address
  /** The pool's quote token (the non-memecoin side). */
  quoteToken: Address
  /** Quote token symbol, e.g. `WETH` or `USDG`. */
  quoteSymbol: string
  side: TradeSide
  /** Memecoin amount that moved, in human units. */
  tokenAmount: number
  /** Quote amount that moved, in human units. */
  quoteAmount: number
  /** Executed price of the memecoin in quote-token units. */
  price: number
  /** Uniswap v3 fee tier of the pool, in hundredths of a bip (3000 = 0.3%). */
  feeTier: number
}

/** Any normalized alert event. */
export type AlertEvent = LaunchEvent | CurveTradeEvent | GraduationEvent | WhaleTradeEvent

/** Narrow an event to a kind. */
export function isKind<K extends AlertEventKind>(
  event: AlertEvent,
  kind: K,
): event is Extract<AlertEvent, { kind: K }> {
  return event.kind === kind
}

/**
 * Human-readable one-line label for an event kind, used by the bot and the
 * notifier formatters.
 */
export const EVENT_KIND_LABELS: Record<AlertEventKind, string> = {
  launch: 'New launch',
  curve_trade: 'Curve trade',
  graduation: 'Graduation',
  whale_trade: 'Whale trade',
}

/**
 * Which event kinds each launchpad can actually produce. The rule engine uses
 * this to reject impossible rules (for example: Odyssey-only `graduation`
 * combined with a NOXA-only launchpad filter would never fire).
 */
export const LAUNCHPAD_EVENT_KINDS: Record<Launchpad, readonly AlertEventKind[]> = {
  noxa: ['launch', 'whale_trade'],
  odyssey: ['launch', 'curve_trade', 'graduation', 'whale_trade'],
}
