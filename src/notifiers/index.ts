/**
 * Delivery adapters: Telegram Bot API, Discord webhook and Discord bot, behind
 * one {@link Notifier} interface, with correct escaping and correct
 * rate-limit handling per platform.
 *
 * @packageDocumentation
 */

export {
  displayLabel,
  escapeDiscordMarkdown,
  escapeHtml,
  escapeHtmlAttribute,
  escapeMarkdownV2,
  escapeMarkdownV2Code,
  escapeMarkdownV2Url,
  htmlLink,
  markdownV2Link,
  shortAddress,
  truncate,
} from './escape.js'

export { EMBED_COLORS, detailRows, formatAmount, formatEth, formatUsd, headline, renderAlert } from './format.js'
export type { RenderOptions } from './format.js'

export { createTelegramClient, createTelegramNotifier } from './telegram.js'
export type {
  TelegramClient,
  TelegramClientOptions,
  TelegramNotifierOptions,
  TelegramResponse,
} from './telegram.js'

export {
  createDiscordBotNotifier,
  createDiscordRateLimiter,
  createDiscordWebhookNotifier,
} from './discord.js'
export type {
  DiscordBotOptions,
  DiscordOptionsBase,
  DiscordRateLimiter,
  DiscordWebhookOptions,
} from './discord.js'

export { createCaptureNotifier } from './capture.js'
export type { CaptureNotifier, CapturedDelivery } from './capture.js'

export { delivered, failed } from './types.js'
export type {
  DeliveryResult,
  DiscordEmbed,
  DiscordEmbedField,
  FetchLike,
  FetchLikeResponse,
  Notifier,
  NotifierHttpOptions,
  RenderedAlert,
} from './types.js'

export { numericHeader, pick, postJson, resolveFetch, sleep } from './http.js'
export type { JsonResponse } from './http.js'
