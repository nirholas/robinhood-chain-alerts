/**
 * Render real chain events into real Telegram and Discord payloads, and
 * deliver them to the capture adapter instead of a chat.
 *
 * This is the notifier layer exercised end to end without any credentials:
 * events come from mainnet, the rule engine decides what matches, the
 * formatters produce the exact bytes each platform would receive, and the
 * capture adapter prints them.
 *
 *   npm run demo:notify
 *   MIN_USD=5000 npm run demo:notify
 */
import { createHoodClient } from 'hoodchain'
import {
  createEventSources,
  createMemoryPoolRegistry,
  createPriceOracle,
  createTokenMetaReader,
} from '../src/events/index.js'
import { matchRules, parseRule } from '../src/rules/index.js'
import { createCaptureNotifier, renderAlert } from '../src/notifiers/index.js'

const lookback = BigInt(process.env['LOOKBACK_BLOCKS'] ?? '20000')
const minUsd = Number(process.env['MIN_USD'] ?? '0')

async function main(): Promise<void> {
  const hood = createHoodClient({
    ...(process.env['ROBINHOOD_RPC_URL'] ? { rpcUrl: process.env['ROBINHOOD_RPC_URL'] } : {}),
  })
  const head = await hood.public.getBlockNumber()
  const from = head > lookback ? head - lookback : 0n
  const to = head - 2n

  const sources = createEventSources({
    client: hood,
    oracle: createPriceOracle(hood),
    tokens: createTokenMetaReader(hood),
    registry: createMemoryPoolRegistry(),
    whaleMinUsd: Number(process.env['WHALE_MIN_USD'] ?? '500'),
  })

  const rules = [
    parseRule({ id: 'launches', name: 'Every launch', kinds: ['launch'] }),
    parseRule({ id: 'graduations', kinds: ['graduation'], launchpads: ['odyssey'] }),
    parseRule({
      id: 'whales',
      kinds: ['whale_trade'],
      ...(minUsd > 0 ? { minUsd } : {}),
    }),
  ]

  const telegram = createCaptureNotifier('telegram')
  const discord = createCaptureNotifier('discord')

  let delivered = 0
  for (const source of sources) {
    const events = await source.poll(from, to)
    for (const event of events) {
      const matches = await matchRules(rules, event)
      for (const { rule } of matches) {
        const alert = renderAlert(event, { footer: `rule: ${rule.id}` })
        await telegram.send('-1001234567890', alert)
        await discord.send('https://discord.com/api/webhooks/000000000000000000/example', alert)
        delivered += 1
        if (delivered > 5) break
      }
      if (delivered > 5) break
    }
    if (delivered > 5) break
  }

  if (delivered === 0) {
    console.log(`No matching events in blocks ${from}-${to}. Widen the window with LOOKBACK_BLOCKS.`)
    return
  }

  const first = telegram.sent[0]
  if (first) {
    console.log('--- Telegram sendMessage text (parse_mode=HTML) ---')
    console.log(first.alert.text)
  }
  const firstDiscord = discord.sent[0]
  if (firstDiscord) {
    console.log('\n--- Discord embed payload ---')
    console.log(JSON.stringify({ embeds: [firstDiscord.alert.embed] }, null, 2))
  }
  console.log(`\ncaptured ${telegram.sent.length} Telegram and ${discord.sent.length} Discord deliveries (nothing was sent)`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
