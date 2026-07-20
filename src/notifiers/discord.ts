import { numericHeader, pick, postJson, resolveFetch, sleep as realSleep } from './http.js'
import {
  delivered,
  failed,
  type DeliveryResult,
  type FetchLike,
  type Notifier,
  type NotifierHttpOptions,
  type RenderedAlert,
} from './types.js'

/**
 * Discord adapters: webhook and bot (application) delivery, behind the same
 * {@link Notifier} interface.
 *
 * Discord's rate limiting is a per-route bucket, published on every response:
 * `X-RateLimit-Remaining` and `X-RateLimit-Reset-After` (seconds, fractional).
 * The correct behaviour is to *not send* once a bucket is exhausted rather
 * than to send and absorb the 429, so this adapter tracks the bucket per route
 * and waits before the request. A 429 that still slips through (a global limit,
 * or another process sharing the token) is honoured through the `retry_after`
 * field in the JSON body, which unlike Telegram's is in **seconds as a float**.
 * `X-RateLimit-Global` marks a token-wide limit, which is applied to every
 * route rather than only the one that hit it.
 */

interface Bucket {
  remaining: number
  resetAtMs: number
}

/** Shared rate-limit state for one Discord credential. */
export interface DiscordRateLimiter {
  /** Wait until `route` may be called. */
  acquire(route: string): Promise<void>
  /** Record what a response said about the bucket. */
  update(route: string, headers: { get(name: string): string | null }): void
  /** Apply a 429, globally when Discord says so. */
  penalise(route: string, retryAfterMs: number, global: boolean): void
}

/** Build the shared rate-limit tracker. */
export function createDiscordRateLimiter(
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = realSleep,
): DiscordRateLimiter {
  const buckets = new Map<string, Bucket>()
  let globalResetAtMs = 0

  return {
    async acquire(route: string): Promise<void> {
      const globalWait = globalResetAtMs - now()
      if (globalWait > 0) await sleep(globalWait)
      const bucket = buckets.get(route)
      if (!bucket) return
      if (bucket.remaining > 0) return
      const wait = bucket.resetAtMs - now()
      if (wait > 0) await sleep(wait)
    },
    update(route: string, headers: { get(name: string): string | null }): void {
      const remaining = numericHeader(headers, 'x-ratelimit-remaining')
      const resetAfter = numericHeader(headers, 'x-ratelimit-reset-after')
      if (remaining === null && resetAfter === null) return
      buckets.set(route, {
        remaining: remaining ?? 1,
        resetAtMs: now() + (resetAfter ?? 0) * 1000,
      })
    },
    penalise(route: string, retryAfterMs: number, global: boolean): void {
      const resetAtMs = now() + retryAfterMs
      if (global) globalResetAtMs = Math.max(globalResetAtMs, resetAtMs)
      buckets.set(route, { remaining: 0, resetAtMs })
    },
  }
}

/** Options shared by both Discord adapters. */
export interface DiscordOptionsBase extends NotifierHttpOptions {
  /** Share one limiter across adapters that use the same credential. */
  limiter?: DiscordRateLimiter
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
  /** Username override for webhook posts. */
  username?: string
}

const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405])

interface SendArgs {
  url: string
  route: string
  payload: unknown
  headers: Record<string, string>
}

async function deliver(
  args: SendArgs,
  options: DiscordOptionsBase,
  fetchImpl: FetchLike,
  limiter: DiscordRateLimiter,
): Promise<DeliveryResult> {
  const maxAttempts = options.maxAttempts ?? 4
  const backoffMs = options.backoffMs ?? 500
  const maxWaitMs = options.maxWaitMs ?? 60_000
  const sleep = options.sleep ?? realSleep

  let attempt = 0
  let lastStatus: number | null = null
  let lastError = 'no attempt was made'
  let retryable = true

  while (attempt < maxAttempts) {
    attempt += 1
    await limiter.acquire(args.route)

    let response
    try {
      response = await postJson(fetchImpl, args.url, args.payload, args.headers)
    } catch (error) {
      lastStatus = null
      lastError = error instanceof Error ? error.message : String(error)
      retryable = true
      if (attempt >= maxAttempts) break
      await sleep(backoffMs * 2 ** (attempt - 1))
      continue
    }

    limiter.update(args.route, response.headers)
    lastStatus = response.status

    if (response.status === 429) {
      const retryAfterField = pick(response.body, 'retry_after')
      const retryAfterSeconds =
        typeof retryAfterField === 'number'
          ? retryAfterField
          : (numericHeader(response.headers, 'retry-after') ?? backoffMs / 1000)
      const isGlobal =
        pick(response.body, 'global') === true ||
        response.headers.get('x-ratelimit-global') === 'true'
      const waitMs = retryAfterSeconds * 1000
      limiter.penalise(args.route, waitMs, isGlobal)
      lastError = `rate limited, retry after ${retryAfterSeconds}s${isGlobal ? ' (global)' : ''}`
      retryable = true
      if (waitMs > maxWaitMs || attempt >= maxAttempts) break
      await sleep(waitMs)
      continue
    }

    if (response.ok) {
      // Webhooks answer 204 with an empty body unless `wait=true` was used.
      const messageId = pick(response.body, 'id')
      return delivered(response.status, attempt, messageId === undefined ? null : String(messageId))
    }

    const message =
      (typeof pick(response.body, 'message') === 'string'
        ? (pick(response.body, 'message') as string)
        : null) ?? response.raw.slice(0, 200)
    lastError = message || `Discord request failed with status ${response.status}`

    if (PERMANENT_STATUSES.has(response.status)) {
      retryable = false
      break
    }
    retryable = true
    if (attempt >= maxAttempts) break
    await sleep(backoffMs * 2 ** (attempt - 1))
  }

  return failed(lastStatus, attempt, lastError, retryable)
}

/** Options for {@link createDiscordWebhookNotifier}. */
export interface DiscordWebhookOptions extends DiscordOptionsBase {
  /**
   * Default webhook URL. Optional: `send()` accepts a webhook URL as its
   * target, which is how per-subscription webhooks work.
   */
  webhookUrl?: string
}

const WEBHOOK_PATTERN = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/

/**
 * Webhook delivery. No bot account, no gateway, no permissions setup: the
 * subscriber pastes a channel webhook URL and alerts arrive. This is the
 * lowest-friction Discord path and the one most subscriptions use.
 *
 * @example
 * ```ts
 * const discord = createDiscordWebhookNotifier()
 * await discord.send('https://discord.com/api/webhooks/123/abc', renderAlert(event))
 * ```
 */
export function createDiscordWebhookNotifier(options: DiscordWebhookOptions = {}): Notifier {
  const fetchImpl = resolveFetch(options.fetch)
  const limiter =
    options.limiter ?? createDiscordRateLimiter(options.now ?? Date.now, options.sleep ?? realSleep)

  return {
    platform: 'discord',
    kind: 'webhook',
    async send(target: string, alert: RenderedAlert): Promise<DeliveryResult> {
      const url = target || options.webhookUrl
      if (!url || !WEBHOOK_PATTERN.test(url)) {
        return failed(
          null,
          0,
          `invalid Discord webhook URL "${target}": expected https://discord.com/api/webhooks/<id>/<token>`,
          false,
        )
      }
      return deliver(
        {
          url: `${url}?wait=true`,
          // Discord buckets webhook routes per webhook id.
          route: `webhook:${url.split('/').slice(-2, -1)[0] ?? url}`,
          payload: {
            embeds: [alert.embed],
            ...(options.username ? { username: options.username } : {}),
          },
          headers: {},
        },
        options,
        fetchImpl,
        limiter,
      )
    },
  }
}

/** Options for {@link createDiscordBotNotifier}. */
export interface DiscordBotOptions extends DiscordOptionsBase {
  /** Bot token from the Discord developer portal (no `Bot ` prefix). */
  botToken: string
  /** API base. @defaultValue `https://discord.com/api/v10` */
  apiBase?: string
}

/**
 * Bot delivery: posts to a channel id with the application's bot token, which
 * is what slash-command subscriptions use (the bot is already in the guild, so
 * no webhook needs creating).
 *
 * @example
 * ```ts
 * const discord = createDiscordBotNotifier({ botToken: process.env.DISCORD_BOT_TOKEN! })
 * await discord.send('1234567890', renderAlert(event))
 * ```
 */
export function createDiscordBotNotifier(options: DiscordBotOptions): Notifier {
  if (!options.botToken.trim()) {
    throw new Error('hood-alerts: DISCORD_BOT_TOKEN is required for the Discord bot notifier')
  }
  const fetchImpl = resolveFetch(options.fetch)
  const apiBase = (options.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '')
  const limiter =
    options.limiter ?? createDiscordRateLimiter(options.now ?? Date.now, options.sleep ?? realSleep)

  return {
    platform: 'discord',
    kind: 'bot',
    async send(target: string, alert: RenderedAlert): Promise<DeliveryResult> {
      if (!/^\d{5,25}$/.test(target)) {
        return failed(null, 0, `invalid Discord channel id "${target}": expected a numeric snowflake`, false)
      }
      return deliver(
        {
          url: `${apiBase}/channels/${target}/messages`,
          route: `channel:${target}`,
          payload: { embeds: [alert.embed] },
          headers: { authorization: `Bot ${options.botToken}` },
        },
        options,
        fetchImpl,
        limiter,
      )
    },
  }
}
