/**
 * Prove the chain-watch path end to end against the real RPC.
 *
 * Connects to Robinhood Chain mainnet, asks every event source for a recent
 * confirmed range, and prints what it decoded. No bot tokens, no database, no
 * writes: this is the fastest way to confirm the RPC, the launchpad decoding
 * and the USD valuation all work from a fresh checkout.
 *
 *   npm run verify:chain
 *   LOOKBACK_BLOCKS=50000 npm run verify:chain
 */
import { createHoodClient } from 'hoodchain'
import {
  createEventSources,
  createMemoryPoolRegistry,
  createPriceOracle,
  createTokenMetaReader,
} from '../src/events/index.js'

const lookback = BigInt(process.env['LOOKBACK_BLOCKS'] ?? '20000')

async function main(): Promise<void> {
  const hood = createHoodClient({
    ...(process.env['ROBINHOOD_RPC_URL'] ? { rpcUrl: process.env['ROBINHOOD_RPC_URL'] } : {}),
  })

  const head = await hood.public.getBlockNumber()
  console.log(`chain 4663, head block ${head}`)

  const oracle = createPriceOracle(hood)
  const ethUsd = await oracle.ethUsd()
  console.log(
    ethUsd === null
      ? 'ETH/USD: no WETH/USDG route with liquidity right now (USD values will be null for ETH legs)'
      : `ETH/USD from live Uniswap v3 liquidity: $${ethUsd.toFixed(2)}`,
  )

  const registry = createMemoryPoolRegistry()
  const sources = createEventSources({
    client: hood,
    oracle,
    tokens: createTokenMetaReader(hood),
    registry,
    whaleMinUsd: Number(process.env['WHALE_MIN_USD'] ?? '500'),
  })

  // A fixed window is useful for replaying a period that is known to have
  // launchpad activity; otherwise the scan trails the head.
  const from = process.env['FROM_BLOCK']
    ? BigInt(process.env['FROM_BLOCK'])
    : head > lookback
      ? head - lookback
      : 0n
  const to = process.env['TO_BLOCK'] ? BigInt(process.env['TO_BLOCK']) : head - 2n
  console.log(`\nscanning blocks ${from} to ${to} (${to - from + 1n} blocks)\n`)

  for (const source of sources) {
    const started = Date.now()
    try {
      const events = await source.poll(from, to)
      console.log(`${source.label.padEnd(20)} ${String(events.length).padStart(4)} events  ${Date.now() - started}ms`)
      for (const event of events.slice(0, 3)) {
        const usd = event.usdValue === null ? 'unpriced' : `$${event.usdValue.toFixed(2)}`
        console.log(`  ${event.kind.padEnd(12)} ${event.symbol ?? '?'} ${event.token} ${usd} block ${event.blockNumber}`)
      }
    } catch (error) {
      console.log(`${source.label.padEnd(20)} FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`\npools discovered and registered for whale watching: ${await registry.size()}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
