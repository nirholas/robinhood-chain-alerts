/**
 * Watch Robinhood Chain memecoin activity live, printing one line per
 * normalized event. No database, no delivery: the event pipeline on its own.
 *
 *   npm run demo:events
 *   WHALE_MIN_USD=250 npm run demo:events
 *
 * Ctrl-C to stop.
 */
import { createHoodClient } from 'hoodchain'
import {
  createEventSources,
  createMemoryPoolRegistry,
  createPriceOracle,
  createTokenMetaReader,
  type EventSource,
} from '../src/events/index.js'
import { formatUsd } from '../src/notifiers/index.js'

const CONFIRMATIONS = 2n
const POLL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? '4000')

async function main(): Promise<void> {
  const hood = createHoodClient({
    ...(process.env['ROBINHOOD_RPC_URL'] ? { rpcUrl: process.env['ROBINHOOD_RPC_URL'] } : {}),
  })
  const registry = createMemoryPoolRegistry()
  const sources = createEventSources({
    client: hood,
    oracle: createPriceOracle(hood),
    tokens: createTokenMetaReader(hood),
    registry,
    whaleMinUsd: Number(process.env['WHALE_MIN_USD'] ?? '500'),
  })

  const head = await hood.public.getBlockNumber()
  const cursors = new Map<string, bigint>(sources.map((source: EventSource) => [source.id, head - CONFIRMATIONS + 1n]))
  console.log(`watching from block ${head - CONFIRMATIONS} (Ctrl-C to stop)`)

  let running = true
  process.on('SIGINT', () => {
    running = false
    console.log('\nstopping')
  })

  while (running) {
    const safeHead = (await hood.public.getBlockNumber()) - CONFIRMATIONS
    for (const source of sources) {
      const from = cursors.get(source.id) as bigint
      if (from > safeHead) continue
      try {
        for (const event of await source.poll(from, safeHead)) {
          console.log(
            `[${event.kind}] ${event.launchpad} ${event.symbol ?? '?'} ${event.token} ` +
              `${formatUsd(event.usdValue)} block ${event.blockNumber} ${event.explorer.tx}`,
          )
        }
        // The cursor advances only after a successful poll, exactly as the
        // service does it, so a transient RPC failure re-reads the range.
        cursors.set(source.id, safeHead + 1n)
      } catch (error) {
        console.error(`${source.id} failed, will retry the same range:`, error instanceof Error ? error.message : error)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
