/**
 * Escaping. The single most common way an alert bot breaks in production.
 *
 * Memecoin names are adversarial input by nature. A token called `WHO_LET_THE`
 * silently italicises half a Telegram message under MarkdownV2 and a token
 * called `<b>RUG` injects markup under HTML parse mode; either way Telegram
 * answers `400 Bad Request: can't parse entities` and the alert is lost. The
 * rules are not symmetric between platforms or even between contexts within a
 * platform, so each context gets its own function and its own tests.
 */

/**
 * Telegram MarkdownV2 reserves exactly these characters in normal text.
 * Source: Telegram Bot API "MarkdownV2 style" section. All 18 of them must be
 * escaped with a preceding backslash anywhere they appear as literal text.
 */
const MARKDOWN_V2_RESERVED = '_*[]()~`>#+-=|{}.!'

/** Escape literal text for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  let out = ''
  for (const char of text) {
    if (MARKDOWN_V2_RESERVED.includes(char)) out += '\\'
    out += char
  }
  return out
}

/**
 * Escape the URL inside a MarkdownV2 inline link `[label](url)`.
 * Inside the parentheses only `)` and `\` are special, and escaping the full
 * reserved set here would corrupt query strings and path separators.
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/[\\)]/g, (char) => `\\${char}`)
}

/**
 * Escape text inside a MarkdownV2 code span or `pre` block. Only `` ` `` and
 * `\` are special there. Escaping the full set would print literal backslashes
 * to the user, which is the classic over-correction of this bug.
 */
export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[\\`]/g, (char) => `\\${char}`)
}

/** Build a MarkdownV2 inline link with both halves escaped correctly. */
export function markdownV2Link(label: string, url: string): string {
  return `[${escapeMarkdownV2(label)}](${escapeMarkdownV2Url(url)})`
}

/**
 * Escape text for Telegram HTML parse mode. Telegram's HTML is a small subset
 * and requires exactly `&`, `<` and `>` to be replaced in text nodes.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value going into an HTML attribute (a link `href`). */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

/** Build a Telegram HTML anchor with both halves escaped. */
export function htmlLink(label: string, url: string): string {
  return `<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`
}

/**
 * Discord markdown special characters. Discord renders markdown inside embed
 * titles, descriptions and field values, so untrusted token names need the
 * same treatment. `#` is not escaped: it is only special at the start of a
 * line for headings, and every place we interpolate a name is mid-line.
 */
const DISCORD_RESERVED = /[\\*_~`|>[\]()]/g

/** Escape literal text for Discord markdown rendering. */
export function escapeDiscordMarkdown(text: string): string {
  return text.replace(DISCORD_RESERVED, (char) => `\\${char}`)
}

/**
 * Truncate to a maximum length without splitting a surrogate pair, which is
 * what turns a long emoji-bearing token name into a replacement character.
 * The ellipsis is included in the budget.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  if (chars.length <= max) return text
  if (max === 1) return '…'
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * A display label for a token: its symbol when the contract exposed one,
 * otherwise a shortened address. Never returns an empty string, because an
 * empty Telegram entity is a 400.
 */
export function displayLabel(symbol: string | null, address: string): string {
  const trimmed = symbol?.trim()
  if (trimmed) return truncate(trimmed, 40)
  return shortAddress(address)
}

/** `0x1234…abcd`, the standard compact address rendering. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
