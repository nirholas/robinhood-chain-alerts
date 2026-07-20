import { formatUnits } from 'viem'
import type { AlertEvent } from '../events/types.js'
import {
  displayLabel,
  escapeDiscordMarkdown,
  escapeHtml,
  escapeMarkdownV2,
  htmlLink,
  markdownV2Link,
  shortAddress,
  truncate,
} from './escape.js'
import type { DiscordEmbed, DiscordEmbedField, RenderedAlert } from './types.js'

/**
 * Message formatting, one alert at a time, for both platforms.
 *
 * Every piece of chain-derived text (token name, symbol) goes through the
 * platform's escaper. Every piece of package-authored text (labels, headings)
 * is written to be escape-safe already, so the output stays readable instead
 * of being a wall of backslashes.
 */

/** Colour per event kind, as Discord's decimal RGB. */
export const EMBED_COLORS = {
  launch: 0x22c55e,
  curve_trade: 0x38bdf8,
  graduation: 0xa855f7,
  whale_trade: 0xf59e0b,
} as const

const KIND_EMOJI = {
  launch: '🚀',
  curve_trade: '📈',
  graduation: '🎓',
  whale_trade: '🐋',
} as const

const LAUNCHPAD_NAMES = { noxa: 'NOXA', odyssey: 'The Odyssey' } as const

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

/** Compact USD rendering: `$1,234.50`, `$12.4K`, `$3.1M`. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unknown'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1)}K`
  return usdFormatter.format(value)
}

/** Human amount rendering with sane precision across 12 orders of magnitude. */
export function formatAmount(value: number): string {
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  if (abs >= 1) return value.toFixed(4).replace(/\.?0+$/, '')
  return value.toPrecision(4)
}

/** ETH amount from wei, with a trailing `ETH`. */
export function formatEth(wei: bigint): string {
  return `${formatAmount(Number(formatUnits(wei < 0n ? -wei : wei, 18)))} ETH`
}

/** The one-line headline for an event, before escaping. */
export function headline(event: AlertEvent): string {
  const label = displayLabel(event.symbol, event.token)
  const pad = LAUNCHPAD_NAMES[event.launchpad]
  switch (event.kind) {
    case 'launch':
      return `${KIND_EMOJI.launch} New launch: ${label} on ${pad}`
    case 'curve_trade':
      return `${KIND_EMOJI.curve_trade} Curve ${event.side}: ${label} for ${formatUsd(event.usdValue)}`
    case 'graduation':
      return `${KIND_EMOJI.graduation} Graduated: ${label} filled its curve`
    case 'whale_trade':
      return `${KIND_EMOJI.whale_trade} Whale ${event.side}: ${formatUsd(event.usdValue)} of ${label}`
  }
}

/** Label/value pairs describing an event, before escaping. */
export function detailRows(event: AlertEvent): { label: string; value: string; inline?: boolean }[] {
  const rows: { label: string; value: string; inline?: boolean }[] = []
  rows.push({ label: 'Launchpad', value: LAUNCHPAD_NAMES[event.launchpad], inline: true })
  if (event.name) rows.push({ label: 'Name', value: truncate(event.name, 64), inline: true })
  rows.push({ label: 'Token', value: shortAddress(event.token), inline: true })

  switch (event.kind) {
    case 'launch': {
      rows.push({
        label: 'Listing',
        value: event.instantListing
          ? 'Instant (live Uniswap v3 pool, no curve)'
          : 'Bonding curve (graduates when filled)',
        inline: true,
      })
      rows.push({ label: 'Deployer', value: shortAddress(event.actor), inline: true })
      if (event.initialBuyAmount > 0n) {
        rows.push({ label: 'Initial buy', value: formatUsd(event.usdValue), inline: true })
      }
      break
    }
    case 'curve_trade': {
      rows.push({ label: 'Side', value: event.side === 'buy' ? 'Buy' : 'Sell', inline: true })
      rows.push({ label: 'Size', value: formatEth(event.quoteAmountWei), inline: true })
      rows.push({ label: 'Value', value: formatUsd(event.usdValue), inline: true })
      rows.push({
        label: 'Tokens',
        value: formatAmount(Number(formatUnits(event.tokenAmount, 18))),
        inline: true,
      })
      rows.push({ label: 'Trader', value: shortAddress(event.actor), inline: true })
      break
    }
    case 'graduation': {
      rows.push({ label: 'Pool', value: shortAddress(event.pool), inline: true })
      rows.push({ label: 'Seeded', value: formatUsd(event.usdValue), inline: true })
      rows.push({ label: 'LP position', value: `#${event.positionId}`, inline: true })
      break
    }
    case 'whale_trade': {
      rows.push({ label: 'Side', value: event.side === 'buy' ? 'Buy' : 'Sell', inline: true })
      rows.push({ label: 'Value', value: formatUsd(event.usdValue), inline: true })
      rows.push({
        label: 'Size',
        value: `${formatAmount(event.tokenAmount)} for ${formatAmount(event.quoteAmount)} ${event.quoteSymbol}`,
        inline: true,
      })
      rows.push({ label: 'Price', value: `${formatAmount(event.price)} ${event.quoteSymbol}`, inline: true })
      rows.push({ label: 'Fee tier', value: `${event.feeTier / 10_000}%`, inline: true })
      rows.push({ label: 'Trader', value: shortAddress(event.actor), inline: true })
      break
    }
  }
  return rows
}

/** Options for {@link renderAlert}. */
export interface RenderOptions {
  /**
   * Telegram parse mode. HTML is the default: its escape rules have three
   * special characters instead of eighteen, which makes malformed-entity 400s
   * far less likely on adversarial token names.
   * @defaultValue `'HTML'`
   */
  parseMode?: 'HTML' | 'MarkdownV2'
  /** Footer text, e.g. the rule that matched. */
  footer?: string
}

/**
 * Render an event for both platforms.
 *
 * @example
 * ```ts
 * const alert = renderAlert(event, { footer: 'rule: whales' })
 * await telegram.send('123456789', alert)
 * await discord.send('987654321', alert)
 * ```
 */
export function renderAlert(event: AlertEvent, options: RenderOptions = {}): RenderedAlert {
  const parseMode = options.parseMode ?? 'HTML'
  const title = headline(event)
  const rows = detailRows(event)
  const label = displayLabel(event.symbol, event.token)

  const linkPairs: { label: string; url: string }[] = [
    { label: 'Transaction', url: event.explorer.tx },
    { label: 'Token', url: event.explorer.token },
  ]
  if (event.explorer.pool) linkPairs.push({ label: 'Pool', url: event.explorer.pool })
  linkPairs.push({ label: 'Actor', url: event.explorer.actor })

  const text =
    parseMode === 'HTML'
      ? [
          `<b>${escapeHtml(title)}</b>`,
          '',
          ...rows.map((row) => `${escapeHtml(row.label)}: <b>${escapeHtml(row.value)}</b>`),
          `Contract: <code>${escapeHtml(event.token)}</code>`,
          '',
          linkPairs.map((link) => htmlLink(link.label, link.url)).join(' · '),
          ...(options.footer ? ['', `<i>${escapeHtml(options.footer)}</i>`] : []),
        ].join('\n')
      : [
          `*${escapeMarkdownV2(title)}*`,
          '',
          ...rows.map((row) => `${escapeMarkdownV2(row.label)}: *${escapeMarkdownV2(row.value)}*`),
          `Contract: \`${event.token}\``,
          '',
          linkPairs.map((link) => markdownV2Link(link.label, link.url)).join(' · '),
          ...(options.footer ? ['', `_${escapeMarkdownV2(options.footer)}_`] : []),
        ].join('\n')

  const fields: DiscordEmbedField[] = rows.map((row) => ({
    name: truncate(row.label, 256),
    value: truncate(escapeDiscordMarkdown(row.value), 1024),
    inline: row.inline ?? false,
  }))
  fields.push({
    name: 'Links',
    value: linkPairs.map((link) => `[${link.label}](${link.url})`).join(' · '),
    inline: false,
  })

  const embed: DiscordEmbed = {
    title: truncate(escapeDiscordMarkdown(title), 256),
    url: event.explorer.tx,
    description: `\`${event.token}\``,
    color: EMBED_COLORS[event.kind],
    fields,
    ...(options.footer ? { footer: { text: truncate(options.footer, 2048) } } : {}),
    ...(event.timestampMs !== null
      ? { timestamp: new Date(event.timestampMs).toISOString() }
      : {}),
  }

  const plain = `${title} | ${label} ${event.token} | block ${event.blockNumber} | ${event.explorer.tx}`

  return { text, parseMode, embed, plain }
}
