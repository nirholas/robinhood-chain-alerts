# Integrating hood-alerts

Everything a third party has to wire up: creating the bots, pointing them at a
deployment, and letting subscribers pay. Nothing here is optional-but-undocumented:
if a step is skipped, the section says exactly what stops working.

The service runs with **no credentials at all** in dry-run mode, so verify the
chain path first and add platforms one at a time.

```bash
cp .env.example .env
npm install && npm run build
DRY_RUN=1 npm start
curl -s localhost:8080/health
```

`/health` reports the head block and which platforms are configured. With no
tokens set, `platforms` is `["dry-run"]` and every matched alert is logged
instead of sent, with the real rendered text.

---

## Telegram

Telegram delivery uses long polling, so the deployment needs **no public URL**,
no TLS certificate and no inbound firewall rule. It works from a laptop, a
container on a private network, or anywhere with outbound HTTPS.

### 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. BotFather replies with a token shaped `123456789:AAH...`. That is
   `TELEGRAM_BOT_TOKEN`.

### 2. Configure and start

```env
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

On startup the service publishes the command list to Telegram (`setMyCommands`),
so subscribers see the `/` menu, and begins long polling. The update offset is
persisted in SQLite, so a restart resumes where it left off instead of
re-processing old commands.

### 3. Subscribe

- **Direct message**: send `/subscribe` to the bot. Alerts go to that chat.
- **Group or channel**: add the bot, then send `/subscribe` in the chat. In a
  group, Telegram only delivers commands addressed to the bot unless privacy
  mode is off, so use `/subscribe@your_bot_name`. To post to a channel, add the
  bot as an administrator with "Post messages".

The subscriber id used for entitlements is `telegram:<user id>` (the person who
ran the command), and the delivery target is the chat id.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `Forbidden: bot was blocked by the user` in the logs, subscription dead-lettered | The user blocked the bot. This is permanent and is not retried; they must unblock and `/subscribe` again |
| Commands ignored in a group | Privacy mode. Use `/command@your_bot_name`, or disable privacy mode with BotFather's `/setprivacy` |
| `chat not found` | The bot was removed from the chat, or the chat id changed when a group was upgraded to a supergroup |
| Alerts stop during a burst | Telegram is rate limiting. The adapter honours `retry_after`; check `hood_alerts_outbox{status="failed"}` in `/metrics` |

---

## Discord

Discord has two delivery paths and they need very different amounts of setup.
Start with the webhook path.

### Option A: webhook delivery (no credentials)

This needs nothing configured on the service at all.

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick the channel, then **Copy Webhook URL**.
3. Subscribe with that URL as the target:
   `/subscribe https://discord.com/api/webhooks/<id>/<token>`

Alerts arrive as embeds. If the webhook is deleted, delivery fails permanently
(`Unknown Webhook`) and the row is dead-lettered rather than retried forever.

Webhook delivery does **not** give you slash commands: to subscribe this way,
the target URL has to reach the command router somehow, which in practice means
running the Telegram bot alongside, or using Option B.

### Option B: a bot application (slash commands and channel delivery)

1. Create an application at
   <https://discord.com/developers/applications>.
2. From **General Information**, copy the **Application ID** and the
   **Public Key**.
3. From **Bot**, create a bot and copy its **token**.
4. Configure the service:

   ```env
   DISCORD_APPLICATION_ID=000000000000000000
   DISCORD_PUBLIC_KEY=<public key>
   DISCORD_BOT_TOKEN=<bot token>
   DISCORD_INTERACTIONS_PATH=/discord/interactions
   ```

5. Register the commands:

   ```bash
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register:discord
   # add DISCORD_GUILD_ID=... to register to one server instantly while testing
   ```

   Global registration takes up to an hour to propagate. Guild registration is
   immediate.

6. Set the application's **Interactions Endpoint URL** to
   `https://<your public host>/discord/interactions`.

   Discord validates the endpoint by sending deliberately invalid signatures and
   refusing to save it unless they get a `401`. hood-alerts verifies every
   request with Ed25519 over `timestamp + rawBody` using the public key from
   step 2, and the HTTP server hands the handler the raw body byte for byte,
   which is why nothing sits in front of it parsing JSON.

   This step is the one that needs a public HTTPS URL. Behind a reverse proxy,
   forward the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers and do
   not rewrite the body.

7. Invite the bot with the **Send Messages** permission and the
   `applications.commands` scope.

The subscriber id used for entitlements is `discord:<guild id>` in a server (so
one server pays once for all its channels) or `discord:<user id>` in a DM.
Command replies are ephemeral: only the person who ran the command sees them.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Discord will not save the interactions endpoint | The service is not reachable, or something between it and Discord is re-serializing the body. The verification is over the exact bytes |
| Slash commands do not appear | Global registration has not propagated yet, or the bot was invited without the `applications.commands` scope |
| `Missing Permissions` on channel delivery | The bot lacks **Send Messages** or **Embed Links** in that channel |
| Alerts pause under load | A rate-limit bucket is exhausted. The adapter waits it out rather than spending a 429; watch `hood_alerts_outbox` in `/metrics` |

---

## Selling premium

Pick one of two entitlement models. The tier limits themselves are identical
either way; only the question "who is premium" changes.

### Configuration-granted (default)

```env
ENTITLEMENTS=static
PREMIUM_SUBSCRIBERS=telegram:12345678,discord:987654321098765432
```

Subscriber ids are exactly what `/tier` prints, so ask a subscriber to run
`/tier` and paste the id back. `ALL_PREMIUM=1` grants premium to everyone, which
is the right setting for a private, self-hosted deployment.

### Paid in USDG on chain

```env
ENTITLEMENTS=both
USDG_RECEIVER=0xYourReceivingAddress
PREMIUM_PRICE_USDG=25
PREMIUM_PERIOD_DAYS=30
PAYMENTS_FROM_BLOCK=12000000
UPGRADE_INSTRUCTIONS=Send 25 USDG to 0xYourReceivingAddress on Robinhood Chain, then run /link.
```

`both` keeps the configuration list working for comps while the chain sells
subscriptions.

The subscriber flow:

1. `/upgrade` shows `UPGRADE_INSTRUCTIONS`.
2. They send USDG to `USDG_RECEIVER` from the wallet they intend to link.
3. `/link` (with no arguments) returns a message containing their subscriber id
   and a single-use nonce.
4. They sign that exact message with the paying wallet (`personal_sign` in any
   wallet, or `account.signMessage` with viem).
5. `/link <address> <signature>` verifies the signature, stores the link and
   consumes the nonce.
6. The service reads USDG `Transfer` logs from that wallet to `USDG_RECEIVER`
   and accrues subscription time: each payment buys `floor(amount / price)`
   periods, starting from whenever the current entitlement would lapse, so
   renewing early extends rather than overwrites.

Set `PAYMENTS_FROM_BLOCK` to the block your receiving address first saw activity.
The scan is one topic-selective log query, and a low start block just makes it
scan more range than it needs to.

Entitlements are cached for five minutes, so a payment is recognised within that
window. If the RPC is unavailable, the last known answer is served rather than
silently downgrading a paying subscriber.

---

## Running it for real

| Concern | What to do |
|---|---|
| Persistence | Mount a volume at the `DB_PATH` directory. Losing the file loses subscriptions and replays `INITIAL_LOOKBACK_BLOCKS` |
| Health checks | Point liveness at `/health` and readiness at `/ready`. `/ready` reports 503 when the poll loop has stalled, which is exactly when a restart helps |
| Metrics | Scrape `/metrics`. The two to alert on are `hood_alerts_lag_blocks` (falling behind the chain) and `hood_alerts_outbox{status="dead"}` (deliveries being given up on) |
| RPC | The public endpoint rate limits bursts. Above a few hundred tracked pools, set `ROBINHOOD_RPC_URL` |
| Scale | One process handles ingestion and delivery. The block cursor and the outbox are in SQLite and assume a single writer: run one instance per database file |
| Upgrades | Cursors, subscriptions and the outbox all survive a restart, so a rolling replacement loses nothing. Stop the old instance before starting the new one against the same file |
