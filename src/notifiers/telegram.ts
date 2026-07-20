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
 * Telegram Bot API adapter.
 *
 * Rate limiting is the part everyone gets wrong. Telegram does not use a
 * header budget: it answers `429` with a JSON body
 * `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7",
 * "parameters":{"retry_after":7}}` and expects the caller to wait exactly that
 * many *seconds* before retrying. This adapter honours `parameters.retry_after`
 * (falling back to the `Retry-After` header, then to exponential backoff), caps
 * the total wait at `maxWaitMs` so one throttled chat cannot stall the whole
 * dispatch loop, and treats `400`/`403` as permanent so a deleted chat or a
 * blocked bot stops being retried forever.
 */

/** A raw Telegram Bot API response. */
export interface TelegramResponse {
  ok: boolean
  status: number
  /** `result` on success. */
  result: unknown
  /** `description` on failure. */
  description: string | null
  /** `parameters.retry_after` in seconds, when Telegram sent one. */
  retryAfterSeconds: number | null
}

/** Options for {@link createTelegramClient}. */
export interface TelegramClientOptions extends NotifierHttpOptions {
  /** Bot token from @BotFather, `<id>:<secret>`. */
  botToken: string
  /** API origin. Override for a local Bot API server. @defaultValue `https://api.telegram.org` */
  apiBase?: string
}

/** A thin, rate-limit-aware Telegram Bot API client. */
export interface TelegramClient {
  /** Call any Bot API method. Retries 429 and 5xx, never retries 4xx. */
  call(method: string, params: Record<string, unknown>): Promise<TelegramResponse>
  /** How many requests the last {@link TelegramClient.call} needed. */
  readonly lastAttempts: number
}

const PERMANENT_STATUSES = new Set([400, 401, 403, 404])

/** Build a Telegram Bot API client. */
export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(options.botToken)) {
    throw new Error('hood-alerts: TELEGRAM_BOT_TOKEN must look like "<bot id>:<secret>"')
  }
  const fetchImpl: FetchLike = resolveFetch(options.fetch)
  const apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const maxAttempts = options.maxAttempts ?? 4
  const backoffMs = options.backoffMs ?? 500
  const maxWaitMs = options.maxWaitMs ?? 60_000
  const sleep = options.sleep ?? realSleep

  let lastAttempts = 0

  return {
    get lastAttempts() {
      return lastAttempts
    },
    async call(method: string, params: Record<string, unknown>): Promise<TelegramResponse> {
      const url = `${apiBase}/bot${options.botToken}/${method}`
      let attempt = 0
      let last: TelegramResponse = {
        ok: false,
        status: 0,
        result: null,
        description: 'no attempt was made',
        retryAfterSeconds: null,
      }

      while (attempt < maxAttempts) {
        attempt += 1
        lastAttempts = attempt
        let response
        try {
          response = await postJson(fetchImpl, url, params)
        } catch (error) {
          // Transport failure: retry with backoff, it is not a Telegram verdict.
          last = {
            ok: false,
            status: 0,
            result: null,
            description: error instanceof Error ? error.message : String(error),
            retryAfterSeconds: null,
          }
          if (attempt >= maxAttempts) break
          await sleep(backoffMs * 2 ** (attempt - 1))
          continue
        }

        const description = typeof pick(response.body, 'description') === 'string'
          ? (pick(response.body, 'description') as string)
          : null
        const retryAfterField = pick(response.body, 'parameters', 'retry_after')
        const retryAfterSeconds =
          typeof retryAfterField === 'number'
            ? retryAfterField
            : numericHeader(response.headers, 'retry-after')

        last = {
          ok: response.status === 200 && pick(response.body, 'ok') === true,
          status: response.status,
          result: pick(response.body, 'result') ?? null,
          description,
          retryAfterSeconds,
        }
        if (last.ok) return last

        if (response.status === 429) {
          const waitMs = (retryAfterSeconds ?? backoffMs / 1000) * 1000
          if (waitMs > maxWaitMs || attempt >= maxAttempts) return last
          await sleep(waitMs)
          continue
        }
        if (PERMANENT_STATUSES.has(response.status)) return last
        if (attempt >= maxAttempts) return last
        await sleep(backoffMs * 2 ** (attempt - 1))
      }
      return last
    },
  }
}

/** Options for {@link createTelegramNotifier}. */
export interface TelegramNotifierOptions extends TelegramClientOptions {
  /** Suppress link previews. @defaultValue `true` (alerts carry several links). */
  disableWebPagePreview?: boolean
  /** Deliver silently, without a notification sound. @defaultValue `false` */
  disableNotification?: boolean
  /** Reuse an existing client instead of building one (the bot shares its client). */
  client?: TelegramClient
}

/**
 * Build the Telegram delivery adapter.
 *
 * @example
 * ```ts
 * const telegram = createTelegramNotifier({ botToken: process.env.TELEGRAM_BOT_TOKEN! })
 * const result = await telegram.send('-1001234567890', renderAlert(event))
 * if (!result.ok) console.error(result.error, 'retryable:', result.retryable)
 * ```
 */
export function createTelegramNotifier(options: TelegramNotifierOptions): Notifier {
  const client = options.client ?? createTelegramClient(options)
  const disableWebPagePreview = options.disableWebPagePreview ?? true
  const disableNotification = options.disableNotification ?? false

  return {
    platform: 'telegram',
    kind: 'bot',
    async send(target: string, alert: RenderedAlert): Promise<DeliveryResult> {
      if (!/^-?\d+$|^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(target)) {
        return failed(
          null,
          0,
          `invalid Telegram chat id "${target}": expected a numeric id or an @username`,
          false,
        )
      }
      const response = await client.call('sendMessage', {
        chat_id: /^-?\d+$/.test(target) ? Number(target) : target,
        text: alert.text,
        parse_mode: alert.parseMode,
        link_preview_options: { is_disabled: disableWebPagePreview },
        disable_notification: disableNotification,
      })
      const attempts = client.lastAttempts

      if (response.ok) {
        const messageId = pick(response.result, 'message_id')
        return delivered(response.status, attempts, messageId === undefined ? null : String(messageId))
      }
      const retryable = response.status === 429 || response.status >= 500 || response.status === 0
      return failed(
        response.status || null,
        attempts,
        response.description ?? `Telegram sendMessage failed with status ${response.status}`,
        retryable,
      )
    },
  }
}
