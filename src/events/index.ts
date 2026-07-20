/**
 * The normalized event taxonomy: launch, curve trade, graduation and whale
 * trade, over both Robinhood Chain memecoin launchpads.
 *
 * @packageDocumentation
 */

export type {
  AlertEvent,
  AlertEventBase,
  AlertEventKind,
  CurveTradeEvent,
  ExplorerLinks,
  GraduationEvent,
  LaunchEvent,
  Launchpad,
  TradeSide,
  WhaleTradeEvent,
} from './types.js'
export { EVENT_KIND_LABELS, LAUNCHPAD_EVENT_KINDS, isKind } from './types.js'

export {
  MAINNET_EXPLORER,
  TESTNET_EXPLORER,
  addressUrl,
  blockUrl,
  explorerBase,
  tokenUrl,
  txUrl,
} from './explorer.js'

export { createPriceOracle, createStaticPriceOracle, quoteTokens } from './pricing.js'
export type { PriceOracle, PriceOracleOptions } from './pricing.js'

export { createTokenMetaReader } from './tokens.js'
export type { TokenMeta, TokenMetaReader } from './tokens.js'

export { createBlockTimeReader } from './blocktime.js'
export type { BlockTimeReader } from './blocktime.js'

export { createMemoryPoolRegistry } from './registry.js'
export type { PoolEntry, PoolRegistry } from './registry.js'

export { createLiquidityReader } from './liquidity.js'
export type { LiquidityReader, LiquidityReaderOptions } from './liquidity.js'

export { batchAddresses, fetchLogRange, isResultTooLarge, isRetryableRpcError } from './logs.js'
export type { FetchLogRangeOptions } from './logs.js'

export {
  SUPPORTED_LAUNCHPADS,
  createEventSources,
  createNoxaLaunchSource,
  createOdysseyCurveTradeSource,
  createOdysseyGraduationSource,
  createOdysseyLaunchSource,
  createWhaleTradeSource,
  eventId,
} from './sources.js'
export type { EventSource, SourceContext } from './sources.js'
