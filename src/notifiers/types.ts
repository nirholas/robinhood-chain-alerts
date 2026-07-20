import type { Platform } from '../rules/schema.js'

/** A Discord embed field. */
export interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

/** The subset of the Discord embed object this package produces. */
export interface DiscordEmbed {
  title: string
  url?: string
  description?: string
  /** Decimal RGB, per Discord's API. */
  color: number
  fields: DiscordEmbedField[]
  footer?: { text: string }
  /** ISO-8601 timestamp. Omitted when the block time was not read. */
  timestamp?: string
}

/**
 * One alert, rendered for every platform up front.
 *
 * Rendering once and letting each notifier pick its representation keeps the
 * escaping rules next to each other (where they can be compared and tested
 * together) and means a fan-out to Telegram and Discord formats the event
 * once, not twice.
 */
export interface RenderedAlert {
  /** Telegram body, escaped for {@link RenderedAlert.parseMode}. */
  text: string
  parseMode: 'HTML' | 'MarkdownV2'
  /** Discord embed representation of the same alert. */
  embed: DiscordEmbed
  /** Unstyled one-line summary, for logs and for platforms added later. */
  plain: string
}

/** What happened when a notifier tried to deliver. */
export interface DeliveryResult {
  ok: boolean
  /** HTTP status of the final attempt, or `null` if the request never completed. */
  status: number | null
  /** How many requests were made, including the successful one. */
  attempts: number
  /** Platform message id, when the API returned one. */
  messageId: string | null
  /** Failure detail. `null` on success. */
  error: string | null
  /**
   * `true` when the failure is worth retrying later (5xx, network, exhausted
   * rate limit). `false` for a permanent rejection such as a bad chat id, so
   * the service can disable a dead subscription instead of retrying forever.
   */
  retryable: boolean
}

/** The one interface every delivery adapter implements. */
export interface Notifier {
  readonly platform: Platform
  /** Adapter flavour, for logs and metrics: `bot`, `webhook`. */
  readonly kind: string
  /**
   * Deliver a rendered alert to a platform-specific target: a Telegram chat
   * id, a Discord channel id, or a Discord webhook URL.
   */
  send(target: string, alert: RenderedAlert): Promise<DeliveryResult>
}

/** The `fetch` shape the adapters use, so tests can substitute a double. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchLikeResponse>

/** The response shape the adapters read. */
export interface FetchLikeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** Options common to every HTTP-backed notifier. */
export interface NotifierHttpOptions {
  /** Injected `fetch`. Defaults to the global. */
  fetch?: FetchLike
  /** Max attempts per delivery, including the first. @defaultValue `4` */
  maxAttempts?: number
  /** Base backoff in ms for retryable failures, doubled per attempt. @defaultValue `500` */
  backoffMs?: number
  /**
   * Upper bound on how long a single delivery will wait for a rate limit, in
   * ms. A `retry_after` beyond this gives up and reports a retryable failure
   * rather than blocking the whole dispatch loop.
   * @defaultValue `60_000`
   */
  maxWaitMs?: number
  /** Sleep injection point for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Request timeout in ms. @defaultValue `15_000` */
  timeoutMs?: number
}

/** A successful send result. */
export function delivered(status: number, attempts: number, messageId: string | null): DeliveryResult {
  return { ok: true, status, attempts, messageId, error: null, retryable: false }
}

/** A failed send result. */
export function failed(
  status: number | null,
  attempts: number,
  error: string,
  retryable: boolean,
): DeliveryResult {
  return { ok: false, status, attempts, messageId: null, error, retryable }
}
