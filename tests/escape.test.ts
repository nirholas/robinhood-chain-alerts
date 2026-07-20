import { describe, expect, it } from 'vitest'
import {
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
} from '../src/notifiers/escape.js'
import { renderAlert } from '../src/notifiers/format.js'
import { addr, launchEvent, whaleTradeEvent } from './helpers.js'

/**
 * Escaping is where alert bots die. Every case below is a real shape a
 * launchpad token has produced: underscores, asterisks, brackets, emoji,
 * markup, and names long enough to blow a field limit.
 */

describe('Telegram MarkdownV2', () => {
  it('escapes all eighteen reserved characters', () => {
    const reserved = '_*[]()~`>#+-=|{}.!'
    const escaped = escapeMarkdownV2(reserved)
    expect(escaped).toBe([...reserved].map((char) => `\\${char}`).join(''))
  })

  it('escapes underscores in a token name so the message does not turn italic', () => {
    expect(escapeMarkdownV2('WHO_LET_THE_DOGS_OUT')).toBe('WHO\\_LET\\_THE\\_DOGS\\_OUT')
  })

  it('escapes asterisks and brackets', () => {
    expect(escapeMarkdownV2('**BOLD** [link]')).toBe('\\*\\*BOLD\\*\\* \\[link\\]')
  })

  it('leaves letters, digits and emoji untouched', () => {
    expect(escapeMarkdownV2('Doge 🐕 to the moon 🚀')).toBe('Doge 🐕 to the moon 🚀')
  })

  it('escapes only ) and backslash inside a link URL', () => {
    const url = 'https://robinhoodchain.blockscout.com/token/0xabc?tab=holders&x=1.2'
    expect(escapeMarkdownV2Url(url)).toBe(url)
    expect(escapeMarkdownV2Url('https://x.example/a(b)c')).toBe('https://x.example/a(b\\)c')
  })

  it('escapes only backtick and backslash inside a code span', () => {
    expect(escapeMarkdownV2Code('a.b-c_d')).toBe('a.b-c_d')
    expect(escapeMarkdownV2Code('tick ` and \\ slash')).toBe('tick \\` and \\\\ slash')
  })

  it('builds a link with each half escaped by its own rules', () => {
    const link = markdownV2Link('Token (v2)', 'https://x.example/a(b)')
    expect(link).toBe('[Token \\(v2\\)](https://x.example/a(b\\))')
  })
})

describe('Telegram HTML', () => {
  it('escapes the three text-node characters', () => {
    expect(escapeHtml('<b>RUG</b> & co')).toBe('&lt;b&gt;RUG&lt;/b&gt; &amp; co')
  })

  it('does not escape quotes in text, but does in an attribute', () => {
    expect(escapeHtml('say "hi"')).toBe('say "hi"')
    expect(escapeHtmlAttribute('say "hi"')).toBe('say &quot;hi&quot;')
  })

  it('escapes ampersands before angle brackets so entities are not double-encoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('builds an anchor with an escaped href', () => {
    expect(htmlLink('Tx', 'https://x.example/a?b=1&c=2')).toBe(
      '<a href="https://x.example/a?b=1&amp;c=2">Tx</a>',
    )
  })
})

describe('Discord markdown', () => {
  it('escapes the characters Discord renders', () => {
    expect(escapeDiscordMarkdown('*bold* _italic_ ~strike~ `code` |spoiler|')).toBe(
      '\\*bold\\* \\_italic\\_ \\~strike\\~ \\`code\\` \\|spoiler\\|',
    )
  })

  it('escapes link syntax so a token name cannot inject a hyperlink', () => {
    expect(escapeDiscordMarkdown('[click](https://evil.example)')).toBe(
      '\\[click\\]\\(https://evil.example\\)',
    )
  })

  it('leaves emoji and plain text alone', () => {
    expect(escapeDiscordMarkdown('PEPE 🐸 2.0')).toBe('PEPE 🐸 2.0')
  })
})

describe('truncation and labels', () => {
  it('truncates without splitting a surrogate pair', () => {
    const emoji = '🚀🚀🚀🚀🚀'
    const truncated = truncate(emoji, 3)
    expect([...truncated]).toHaveLength(3)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated).not.toContain('�')
  })

  it('leaves short strings untouched', () => {
    expect(truncate('short', 10)).toBe('short')
  })

  it('falls back to a short address when a token has no symbol', () => {
    expect(displayLabel(null, addr(1))).toBe(shortAddress(addr(1)))
    expect(displayLabel('   ', addr(1))).toBe(shortAddress(addr(1)))
    expect(displayLabel('PEPE', addr(1))).toBe('PEPE')
  })

  it('caps an absurdly long symbol', () => {
    const label = displayLabel('X'.repeat(500), addr(1))
    expect([...label].length).toBeLessThanOrEqual(40)
  })
})

describe('rendered alerts survive adversarial names', () => {
  const nasty = 'PEPE_2.0 **[FREE]** <script>alert(1)</script> 🐸'

  it('escapes the name for Telegram HTML', () => {
    const alert = renderAlert(launchEvent({ name: nasty, symbol: 'A*B_C' }))
    expect(alert.parseMode).toBe('HTML')
    expect(alert.text).not.toContain('<script>')
    expect(alert.text).toContain('&lt;script&gt;')
  })

  it('escapes the name for Telegram MarkdownV2, leaving no unescaped reserved character', () => {
    const alert = renderAlert(launchEvent({ name: nasty, symbol: 'A*B_C' }), { parseMode: 'MarkdownV2' })
    // Strip escaped pairs, the code span (which has its own rules) and link
    // URLs, then assert nothing reserved survives in the remaining text.
    const withoutEscapes = alert.text
      .replace(/`[^`]*`/g, '')
      .replace(/\]\([^)]*\)/g, '')
      .replace(/\\./g, '')
    expect(withoutEscapes).not.toMatch(/[_~>#+=|{}!]/)
  })

  it('escapes the name for a Discord embed', () => {
    const alert = renderAlert(launchEvent({ name: nasty }))
    const nameField = alert.embed.fields.find((field) => field.name === 'Name')
    expect(nameField?.value).toContain('\\*\\*')
    expect(nameField?.value).toContain('\\_')
  })

  it('keeps every Discord embed field inside the API limits', () => {
    const alert = renderAlert(whaleTradeEvent({ name: 'N'.repeat(4_000), symbol: 'S'.repeat(200) }))
    expect([...alert.embed.title].length).toBeLessThanOrEqual(256)
    for (const field of alert.embed.fields) {
      expect([...field.name].length).toBeLessThanOrEqual(256)
      expect([...field.value].length).toBeLessThanOrEqual(1024)
    }
  })

  it('omits the embed timestamp when the block time was never read', () => {
    expect(renderAlert(launchEvent({ timestampMs: null })).embed.timestamp).toBeUndefined()
    expect(renderAlert(launchEvent({ timestampMs: 1_700_000_000_000 })).embed.timestamp).toBe(
      new Date(1_700_000_000_000).toISOString(),
    )
  })
})
