# hood-alerts

**Telegram and Discord alert bots for [Robinhood Chain](https://docs.robinhood.com/chain/) memecoins (chain ID 4663): new launches, graduations, whale trades. Hosted service, free and premium tier.**

Chain watching is not this package's job. [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) already has the launchpad watchers, the sequencer firehose and the Uniswap v3 quote path, and [`hoodkit`](https://github.com/nirholas/robinhood-chain-kit) has the swap decoding. hood-alerts is everything above them, which is where an alert product actually lives:

- a normalized **event taxonomy** over both launchpads, with honest USD values,
- a schema-validated **rule engine** whose rules are data a subscriber can edit from chat,
- **delivery adapters** that get escaping and rate limiting right on both platforms,
- the **bot** command surface,
- an enforced **tier policy**,
- and a **hosted service** that survives a restart mid-stream without double-sending or silently skipping a block.

Docs: **https://nirholas.github.io/hood-alerts/**

## The thing most memecoin alert bots get wrong

Robinhood Chain has two memecoin launchpads and they do not have the same lifecycle. Treating them as one product produces alerts that are simply false.

| | NOXA (`fun.noxa.fi/robinhood`) | The Odyssey (`theodyssey.fun`) |
|---|---|---|
| Model | Instant launcher | pump.fun-style bonding curve with virtual reserves |
| At launch | Deploys the ERC-20, creates a Uniswap v3 pool, seeds single-sided liquidity and locks the LP NFT, all in one transaction | Opens a curve. No pool exists yet |
| Trading | Normal Uniswap v3 swaps from block one | On the curve until it fills |
| Graduation | **Never happens. There is no curve to fill** | `PoolCompleted` + `PoolMigrated` when the curve fills and liquidity moves to a locked Uniswap v3 pool |
| Emits | `launch`, `whale_trade` | `launch`, `curve_trade`, `graduation`, `whale_trade` |

A "NOXA graduation" alert would describe an event that does not exist on chain. hood-alerts encodes that asymmetry in the types and in the rule schema, so an impossible rule is **rejected at validation time** instead of being accepted and never firing:

```ts
import { safeParseRule } from 'hood-alerts/rules'

const result = safeParseRule({ id: 'nope', kinds: ['graduation'], launchpads: ['noxa'] })
console.log(result.success)
// false: "this combination can never fire: NOXA is an instant launcher with no
// bonding curve, so it emits no curve_trade and no graduation"
```

## Event taxonomy

Every event carries a stable id (`kind:txHash:logIndex`), the token, the actor, the block, the transaction hash, a USD value and explorer links.

| Kind | Source | Launchpads | `usdValue` is | Extra fields |
|---|---|---|---|---|
| `launch` | NOXA `TokenLaunched`, Odyssey `TokenCreated` | both | the deployer's initial buy (NOXA), or `null` (Odyssey: the curve holds the liquidity) | `pool`, `pairToken`, `initialBuyAmount`, `positionId`, `instantListing` |
| `curve_trade` | Odyssey `Traded` on a bonding-curve factory | Odyssey only | the native-ETH leg, priced through live WETH/USDG liquidity | `side`, `tokenAmount`, `quoteAmountWei`, `feeWei`, `virtualQuoteWei`, `virtualTokenAmount`, `priceEth` |
| `graduation` | Odyssey `PoolMigrated` | Odyssey only | the quote side used to seed the migrated pool | `pool`, `positionId`, `liquidity`, `tokenUsed`, `quoteUsed` |
| `whale_trade` | Uniswap v3 `Swap` on a tracked memecoin pool | both | the swap's quote leg | `pool`, `quoteToken`, `quoteSymbol`, `side`, `tokenAmount`, `quoteAmount`, `price`, `feeTier` |

### USD values are measured, never assumed

There is no hardcoded price anywhere in this package.

- **USDG legs are the unit of account.** USDG is the chain's fully reserved dollar stablecoin at 6 decimals, so a USDG leg is its own USD value.
- **ETH legs are priced through the chain's own liquidity.** `hoodchain`'s `quoteSwap` is asked for the real output of selling 1 WETH into USDG across every fee tier and two-hop route, cached for 30 seconds and coalesced so a burst of events makes one quote.
- **Anything else is `null`.** A memecoin/memecoin pool has no honest USD value from chain data alone, so the event says so and a `minUsd` rule does not match it. Unknown is never treated as zero (which would satisfy every `maxUsd` filter) or as infinity.

### Evidence: every source decoded against mainnet

`npm run verify:chain` runs the whole read path against the public RPC with no credentials, no database and no writes. Replaying the launchpads' first 1.44 million blocks:

```
$ FROM_BLOCK=61688 TO_BLOCK=1500000 npm run verify:chain

chain 4663, head block 15010850
ETH/USD from live Uniswap v3 liquidity: $1905.26

scanning blocks 61688 to 1500000 (1438313 blocks)

NOXA launches        2621 events  217029ms
  launch       ? 0x6399E2Bd8af62C0ac13f55613C3469b67332a6Fd $266.74 block 61869
  launch       HUSK 0x57EB9C9153cfE0277F91Ff8B8604C2D3006a9196 $9.53 block 61987
  launch       JOHN 0x1E963A1539681d0B877570F8bdC000cbE8404fC4 $95.26 block 62204
Odyssey launches        4 events  757ms
  launch       ROBIN 0xfB4729659eeF22Bfc1c2B680F6F873f8147aaaab unpriced block 983265
Odyssey curve trades  110 events  2482ms
  curve_trade  ROBIN 0xfB4729659eeF22Bfc1c2B680F6F873f8147aaaab $18.67 block 983265
Odyssey graduations     1 events  344ms
  graduation   ROBIN 0xfB4729659eeF22Bfc1c2B680F6F873f8147aaaab $7618.47 block 1048638
Whale trades         4045 events  83886ms
  whale_trade  CHEEMS 0xdaA213A0Bd8B048D6022e2c46df877E8A204072b $190.46 block 1439024

pools discovered and registered for whale watching: 2622
```

Read the ROBIN token across those four lines and the taxonomy proves itself: a curve opens (`launch`, unpriced, because a curve holds no pool), trades on the curve (`curve_trade`, priced through the ETH leg), then fills and migrates (`graduation`, $7,618.47 of liquidity seeded). NOXA tokens never appear in the middle two rows, because they cannot. The first NOXA launch has no `symbol()` and renders as `?` rather than dropping the alert.

The whale row also shows the pool set working: 2,622 pools were discovered from launchpad activity during the same scan, and the whale watcher queried exactly those.

## Install

```bash
npm install hood-alerts hoodchain hoodkit viem
```

Node >= 20. `hoodchain`, `hoodkit` and `viem` are peer dependencies.

## Quickstart: the event pipeline

```ts
import { createHoodClient } from 'hoodchain'
import {
  createEventSources,
  createMemoryPoolRegistry,
  createPriceOracle,
  createTokenMetaReader,
} from 'hood-alerts/events'

const hood = createHoodClient()
const sources = createEventSources({
  client: hood,
  oracle: createPriceOracle(hood),
  tokens: createTokenMetaReader(hood),
  registry: createMemoryPoolRegistry(),
})

const head = await hood.public.getBlockNumber()
for (const source of sources) {
  for (const event of await source.poll(head - 5_000n, head - 2n)) {
    console.log(event.kind, event.symbol, event.usdValue, event.explorer.tx)
  }
}
```

## Quickstart: rules and delivery

```ts
import { matchRules, parseRule } from 'hood-alerts/rules'
import { createTelegramNotifier, renderAlert } from 'hood-alerts/notifiers'

const rules = [
  parseRule({ id: 'whales', name: 'Whale buys over $25k', kinds: ['whale_trade'], minUsd: 25_000, side: 'buy' }),
  parseRule({ id: 'grads', kinds: ['graduation'], launchpads: ['odyssey'] }),
]

const telegram = createTelegramNotifier({ botToken: process.env.TELEGRAM_BOT_TOKEN as string })

for (const { rule } of await matchRules(rules, event)) {
  const result = await telegram.send('-1001234567890', renderAlert(event, { footer: `rule: ${rule.id}` }))
  if (!result.ok) console.error(result.error, 'retryable:', result.retryable)
}
```

To see the exact bytes each platform would receive, with real chain events and no credentials:

```bash
npm run demo:notify
```

## Rules are data

A rule is a JSON document validated by a [Zod](https://zod.dev) schema, so it can be stored per subscriber, edited from a chat command, exported and diffed. The schema is the single source of truth: the bot, the service and the tier policy all validate through it.

| Field | Type | Filter |
|---|---|---|
| `id` | slug | Stable id, unique per subscription |
| `name` | string | Label shown in `/rules` |
| `enabled` | boolean | Off without deleting |
| `kinds` | `launch` / `curve_trade` / `graduation` / `whale_trade` | Which events |
| `launchpads` | `noxa` / `odyssey` | Which launchpad |
| `minUsd`, `maxUsd` | number | USD value band. An unpriced event never matches |
| `minLiquidityUsd`, `maxLiquidityUsd` | number | Deepest known pool's USD reserves |
| `tokens` | address[] | Watchlist. Non-empty means only these tokens |
| `deployers` | address[] | Only these actors |
| `excludeDeployers` | address[] | Never these actors |
| `side` | `buy` / `sell` / `any` | Trade direction (trades only) |
| `reputation.minPriorLaunches` | int | Deployer's prior launches as of the event's block |
| `reputation.maxPriorLaunches` | int | Rejects serial deployers |
| `reputation.maxRuggedLaunches` | int | Rejects deployers with drained pools |
| `reputation.requireLpLocked` | boolean | LP NFT held by the launchpad locker |
| `rateLimit.maxPerHour` | int | Cap per rolling hour |
| `rateLimit.minIntervalSeconds` | int | Minimum gap between alerts |

Evaluation is lazy and ordered: cheap in-memory filters run before anything that costs an RPC call, so a rule that rejects an event on its kind never triggers a pool balance read. With thousands of subscriptions that is the difference between keeping up with the chain and not.

### Deployer reputation is derived on chain

Nothing is scraped, self-reported or scored by a model.

- **Prior launches**: `TokenLaunched` logs on the NOXA factory indexed by `deployer`, plus `TokenCreated` on the three Odyssey factories indexed by `creator`. Both queries are topic-selective, so the RPC serves the full chain history in one call each. Counted relative to the event's own block, so replaying a historical range gives the same answer twice.
- **LP locked**: `NonfungiblePositionManager.ownerOf(positionId)` equals the NOXA locker contract. That is the launchpad's own permanent-lock mechanism, read directly rather than trusted from a UI badge.
- **Drained**: a prior launch whose pool quote reserve is now below the rug threshold (default $50). This is a **heuristic** and is labelled as one everywhere it appears: a token that never traded and a token whose liquidity was pulled both end up with an empty pool. Pair it with `minPriorLaunches` for a meaningful signal.

```bash
npx tsx examples/deployer-reputation.ts 0xYourDeployerAddress
```

## Escaping, because that is how alert bots die

Memecoin names are adversarial input by nature. A token called `WHO_LET_THE` italicises half a MarkdownV2 message; a token called `<b>RUG` injects markup under HTML parse mode. Either way Telegram answers `400 Bad Request: can't parse entities` and the alert is lost.

Each context gets its own escaper and its own tests, because the rules are not symmetric even within one platform:

| Context | Escaped |
|---|---|
| Telegram MarkdownV2 text | all 18 of ``_*[]()~`>#+-=\|{}.!`` |
| MarkdownV2 link URL | only `)` and `\` (escaping the full set corrupts query strings) |
| MarkdownV2 code span | only `` ` `` and `\` |
| Telegram HTML text | `&`, `<`, `>` |
| Telegram HTML attribute | the above plus `"` |
| Discord embeds | ``\*_~`\|>[]()`` |

Telegram delivery defaults to HTML: three special characters instead of eighteen makes a malformed-entity 400 far less likely on hostile input. Truncation is surrogate-pair aware, so a long emoji-bearing name is cut cleanly instead of ending in a replacement character.

## Rate limiting, per each platform's actual contract

The two platforms do not work the same way, and treating them the same is how a bot gets throttled into silence.

- **Telegram** answers `429` with `parameters.retry_after` in **whole seconds** and expects exactly that wait. hood-alerts honours it (falling back to the `Retry-After` header, then to exponential backoff), caps the total wait at `maxWaitMs` so one throttled chat cannot stall the dispatch loop, and treats `400`/`403` as permanent so a deleted chat or a blocked bot stops being retried forever.
- **Discord** publishes a per-route bucket on every response (`X-RateLimit-Remaining`, `X-RateLimit-Reset-After` in **fractional seconds**). The correct behaviour is to not send once a bucket is exhausted rather than to send and spend a 429, so the adapter waits before the request. A 429 that still slips through carries `retry_after` as a float, and `X-RateLimit-Global` is applied to every route rather than only the one that hit it.

## The service

One process: poll the chain, match rules, queue deliveries, drain the queue, serve health and metrics.

```bash
cp .env.example .env      # nothing is required for a dry run
npm install
npm run build
DRY_RUN=1 npm start
```

```bash
docker build -t hood-alerts .
docker run --rm -p 8080:8080 -v hood-alerts-data:/app/data \
  -e TELEGRAM_BOT_TOKEN=123456789:AA... hood-alerts
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness, head block, last poll, configured platforms |
| `GET /ready` | 503 when the poll loop has stalled, so an orchestrator restarts a process that is alive but no longer ingesting |
| `GET /metrics` | Prometheus text: subscriptions, outbox by status, deliveries per hour, tracked pools, per-source cursor and lag |
| `POST /discord/interactions` | Discord slash commands (Ed25519 verified) |

### Surviving a restart mid-stream

This is the part that is easy to get wrong and expensive to get wrong: an alert bot that double-sends is spam, and one that skips a range misses the launch its subscribers paid for.

1. **Never double-send.** Every potential delivery has a deterministic primary key, `eventId|subscriptionId|ruleId`, and the event id comes from the transaction hash and log index. Re-processing a block range regenerates identical keys, so the second pass inserts nothing.
2. **Never silently skip.** The block cursor advances only after every event in a chunk has been enqueued and committed. A crash mid-chunk leaves the cursor at the start of that chunk, so the range is re-read. A failed RPC call leaves it untouched for the same reason.
3. **Never lose an enqueued alert.** Queued rows live in an outbox until they are delivered or dead-lettered. On startup, rows left in `sending` (a crash mid-flight) return to `pending` and are retried.

The one honest caveat: if the process dies after the platform accepted a message but before the row was marked `sent`, that alert goes out twice. Neither the Telegram nor the Discord send API takes a client-supplied idempotency key, so that window cannot be closed from here. Everything outside it is exactly once.

All three properties are tested, including a simulated crash part way through writing a batch:

```
✓ cursor semantics > leaves the cursor untouched when a source throws, so nothing is skipped
✓ dedupe > enqueues an event once even when the same range is processed twice
✓ crash recovery > re-processes only the unfinished range after a crash mid-batch
✓ crash recovery > returns rows abandoned in flight to the queue on restart
```

## Bot command reference

The same router serves Telegram (long polling, so no public URL, TLS certificate or inbound firewall rule is needed) and Discord (slash commands over the HTTP interactions endpoint). Every command answers bad input with a specific, actionable message.

| Command | What it does |
|---|---|
| `/start`, `/help` | Every command, plus the launchpad lifecycle explanation |
| `/subscribe [target]` | Send alerts here with a starter rule set. On Discord the target may be a webhook URL or a channel id; it defaults to the current channel |
| `/unsubscribe [id]` | Stop a subscription. Lists them when there is more than one |
| `/rules` | Every rule on every subscription, with its filters |
| `/rule add {json}` | Add a rule. Validation errors come back as the field that failed |
| `/rule rm\|on\|off <id>` | Remove, enable or disable a rule |
| `/threshold <rule> <usd>` | Set a rule's minimum USD value |
| `/watch <token> [rule]` | Add a token to a rule's watchlist |
| `/unwatch <token> [rule]` | Remove one |
| `/tier` | Your tier, its limits, and where the entitlement came from |
| `/status` | Subscriptions, rule counts, alerts used this hour |
| `/link [address] [signature]` | Link the wallet that pays. Send it bare to get the message to sign |
| `/upgrade` | How to go premium on this deployment |

Register the Discord slash commands with:

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register:discord
```

[INTEGRATION.md](./INTEGRATION.md) has the full Telegram and Discord setup, including the interactions endpoint.

## Tiers are enforced, not advertised

Every limit maps to a real cost the service pays, and the check lives in exactly one place (`createEntitlementGate`). The bot asks it before accepting a subscription or a rule; the dispatcher asks it before queuing a delivery. Nothing else reads the policy table, so the two cannot disagree about who is premium.

| | Free | Premium |
|---|---|---|
| Subscriptions | 1 | 10 |
| Rules per subscription | 3 | 50 |
| Filters per rule | 3 | 24 |
| Watchlist size | 5 | 500 |
| Alerts per hour | 30 | 2,000 |
| Delivery delay | 60s | none |
| Liquidity and reputation filters | no | yes |
| Event kinds | `launch`, `graduation`, `whale_trade` | all four, including the `curve_trade` firehose |

The delivery delay is enforced in the outbox (the row carries `not_before`), so it survives a restart instead of being a `setTimeout` a crash erases.

### Entitlements: what actually ships

`EntitlementProvider` is a one-method interface and two implementations ship. **Both work; neither is a placeholder.**

1. **`createStaticEntitlementProvider` is the documented default.** Premium comes from `PREMIUM_SUBSCRIBERS` (or `ALL_PREMIUM=1` for a private deployment). No dependencies, works offline, and is what a self-hoster running the bot for their own community wants.
2. **`createUsdgEntitlementProvider` is a working on-chain rail.** It reads USDG `Transfer` logs from a subscriber's linked wallet to the operator's `USDG_RECEIVER` and accrues subscription time from those real payments: each payment buys `floor(amount / price)` periods, starting from whenever the current entitlement would have lapsed, so renewing early extends rather than overwrites. No facilitator, no card processor, no third-party service. USDG is the chain's own dollar and the ledger is the chain.

Wallet linking is signature-verified (EIP-191 `personal_sign` over a server-issued, single-use nonce), so nobody inherits a paying subscriber's entitlement by pasting their address.

```env
ENTITLEMENTS=both
USDG_RECEIVER=0xYourReceivingAddress
PREMIUM_PRICE_USDG=25
PREMIUM_PERIOD_DAYS=30
PAYMENTS_FROM_BLOCK=12000000
```

A deliberate non-choice: hood-alerts does **not** wire the sibling `hood402` x402 rail. x402 prices a single HTTP request, and a subscription is not a request. Bolting one onto the other would have produced a payment integration that demos but does not work. The USDG provider is the honest version of the same idea, and `EntitlementProvider` is one method wide for anyone who wants a different one.

## API

| Export | From | What it is |
|---|---|---|
| `createEventSources` | `hood-alerts/events` | Every source for a mainnet client. Throws on testnet, where neither launchpad exists |
| `createNoxaLaunchSource`, `createOdysseyLaunchSource`, `createOdysseyCurveTradeSource`, `createOdysseyGraduationSource`, `createWhaleTradeSource` | `hood-alerts/events` | The sources individually |
| `createPriceOracle`, `createStaticPriceOracle` | `hood-alerts/events` | USD valuation from live liquidity, or a fixed rate |
| `createLiquidityReader` | `hood-alerts/events` | Pool reserves in USD, cached |
| `createMemoryPoolRegistry` | `hood-alerts/events` | The tracked memecoin pool set |
| `fetchLogRange` | `hood-alerts/events` | `eth_getLogs` that bisects on the result cap and retries rate limits |
| `parseRule`, `safeParseRule`, `ruleSchema`, `subscriptionSchema` | `hood-alerts/rules` | Rule validation |
| `evaluateRule`, `matchRules` | `hood-alerts/rules` | The engine |
| `checkRateLimit`, `createMemoryRateLimitStore` | `hood-alerts/rules` | Per-rule rate limiting |
| `createRpcReputationProvider` | `hood-alerts/rules` | On-chain deployer history |
| `renderAlert` | `hood-alerts/notifiers` | One event rendered for both platforms |
| `createTelegramNotifier`, `createTelegramClient` | `hood-alerts/notifiers` | Telegram Bot API |
| `createDiscordWebhookNotifier`, `createDiscordBotNotifier` | `hood-alerts/notifiers` | Discord, both delivery paths |
| `createCaptureNotifier` | `hood-alerts/notifiers` | Records instead of sending. Backs `DRY_RUN=1` |
| `escapeMarkdownV2`, `escapeHtml`, `escapeDiscordMarkdown` | `hood-alerts/notifiers` | The escapers, individually testable |
| `createCommandRouter`, `COMMANDS` | `hood-alerts/bot` | The shared command surface |
| `createTelegramBot` | `hood-alerts/bot` | Long-polling front end |
| `createDiscordInteractionHandler`, `registerDiscordCommands`, `verifyDiscordSignature` | `hood-alerts/bot` | Slash commands and Ed25519 verification |
| `TIER_POLICIES`, `createEntitlementGate` | `hood-alerts/tiers` | The policy table and the one chokepoint |
| `createStaticEntitlementProvider`, `createUsdgEntitlementProvider` | `hood-alerts/tiers` | Who is premium |
| `AlertStore` | `hood-alerts/service` | SQLite state: subscriptions, outbox, cursors, pools, links |
| `createDispatcher` | `hood-alerts/service` | `pollOnce` and `flushOnce` |
| `createService`, `loadConfig` | `hood-alerts/service` | The whole thing, wired |

## Limits and caveats

- **Mainnet only.** NOXA and The Odyssey are deployed on chain 4663. Building sources against testnet throws rather than reporting an empty chain as "no launches".
- **Whale trades cover a tracked pool set, not every pool on the chain.** A topic-only Uniswap v3 `Swap` query overflows the public RPC's 10,000-log result cap in under 2,000 blocks, so "watch everything" is not something the endpoint can serve. The pool set is assembled from launchpad activity (NOXA pools at launch, Odyssey pools at graduation), capped by `WHALE_POOL_LIMIT` newest-first, with every subscriber's watchlist tokens pinned on top of the cap. A pool the service has never seen a launch for is not watched.
- **A fresh database starts `INITIAL_LOOKBACK_BLOCKS` behind the head.** Deleting the SQLite file loses subscriptions and replays that window. Mount it on a volume.
- **Liquidity is total pool reserves, not tradeable depth.** For concentrated Uniswap v3 positions the reserve inside the active tick can be far smaller. Read `minLiquidityUsd` as "how much is in there", not "how much I can sell into".
- **The rug figure is a heuristic**, defined precisely above. It is evidence, not a verdict.
- **Rate-limit quota is consumed at enqueue, not at send.** An alert that is queued and then dead-lettered still counted against the hour. Counting at send time would let one block's events blow through every cap before the first delivery.
- **The public RPC throttles bursts.** Above a few hundred tracked pools, set `ROBINHOOD_RPC_URL` to a dedicated endpoint.

## Development

```bash
npm install
npm run typecheck
npm test               # 219 tests
npm run build
npm run verify:chain   # against the real RPC, no credentials
```

## License

Proprietary, all rights reserved. See [LICENSE](./LICENSE).
