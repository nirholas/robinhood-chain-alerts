import { describe, expect, it } from 'vitest'
import { createTelegramClient, createTelegramNotifier } from '../src/notifiers/telegram.js'
import {
  createDiscordBotNotifier,
  createDiscordRateLimiter,
  createDiscordWebhookNotifier,
} from '../src/notifiers/discord.js'
import { createCaptureNotifier } from '../src/notifiers/capture.js'
import { renderAlert } from '../src/notifiers/format.js'
import {
  advancingSleep,
  fakeClock,
  recordingSleep,
  scriptedFetch,
  throwingFetch,
  whaleTradeEvent,
} from './helpers.js'

const TOKEN = '123456789:AAHtest-token_value'
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-123_token'
const alert = renderAlert(whaleTradeEvent())

describe('Telegram delivery', () => {
  it('sends and reports the message id', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { ok: true, result: { message_id: 4242 } } }])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch })
    const result = await notifier.send('-1001234567890', alert)

    expect(result.ok).toBe(true)
    expect(result.messageId).toBe('4242')
    expect(result.attempts).toBe(1)
    expect(fetch.requests).toHaveLength(1)
    const request = fetch.requests[0]
    expect(request?.url).toContain(`/bot${TOKEN}/sendMessage`)
    expect((request?.body as { parse_mode: string }).parse_mode).toBe('HTML')
    expect((request?.body as { chat_id: number }).chat_id).toBe(-1001234567890)
  })

  it('honours parameters.retry_after on a 429 and then succeeds', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([
      {
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 7',
          parameters: { retry_after: 7 },
        },
      },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    ])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch, sleep })
    const result = await notifier.send('123', alert)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    // Exactly the seconds Telegram asked for, converted to ms. Not a backoff guess.
    expect(sleep.waits).toEqual([7_000])
  })

  it('falls back to the Retry-After header when the body omits the field', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([
      { status: 429, body: { ok: false, description: 'slow down' }, headers: { 'retry-after': '3' } },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    ])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch, sleep })
    await notifier.send('123', alert)
    expect(sleep.waits).toEqual([3_000])
  })

  it('gives up rather than blocking on a retry_after beyond maxWaitMs', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([
      { status: 429, body: { ok: false, description: 'flood wait', parameters: { retry_after: 3_600 } } },
    ])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch, sleep, maxWaitMs: 60_000 })
    const result = await notifier.send('123', alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(sleep.waits).toEqual([])
    expect(fetch.requests).toHaveLength(1)
  })

  it('does not retry a permanent 403', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([
      { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } },
    ])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch, sleep })
    const result = await notifier.send('123', alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.error).toMatch(/blocked/)
    expect(fetch.requests).toHaveLength(1)
  })

  it('retries a 500 with exponential backoff', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([
      { status: 500, body: { ok: false, description: 'Internal Server Error' } },
      { status: 500, body: { ok: false, description: 'Internal Server Error' } },
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
    ])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch, sleep, backoffMs: 100 })
    const result = await notifier.send('123', alert)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(3)
    expect(sleep.waits).toEqual([100, 200])
  })

  it('retries a transport failure and reports it as retryable', async () => {
    const sleep = recordingSleep()
    const notifier = createTelegramNotifier({
      botToken: TOKEN,
      fetch: throwingFetch('socket hang up'),
      sleep,
      maxAttempts: 2,
      backoffMs: 50,
    })
    const result = await notifier.send('123', alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toBe('socket hang up')
    expect(sleep.waits).toEqual([50])
  })

  it('rejects a malformed chat id without an HTTP call', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { ok: true } }])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch })
    const result = await notifier.send('not a chat', alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(fetch.requests).toHaveLength(0)
  })

  it('accepts an @channel username target', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { ok: true, result: { message_id: 5 } } }])
    const notifier = createTelegramNotifier({ botToken: TOKEN, fetch })
    const result = await notifier.send('@somechannel', alert)
    expect(result.ok).toBe(true)
    expect((fetch.requests[0]?.body as { chat_id: string }).chat_id).toBe('@somechannel')
  })

  it('rejects a malformed bot token at construction', () => {
    expect(() => createTelegramClient({ botToken: 'nonsense' })).toThrow(/bot id/)
  })
})

describe('Discord delivery', () => {
  it('posts an embed to a webhook', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { id: '555' } }])
    const notifier = createDiscordWebhookNotifier({ fetch })
    const result = await notifier.send(WEBHOOK, alert)

    expect(result.ok).toBe(true)
    expect(result.messageId).toBe('555')
    const body = fetch.requests[0]?.body as { embeds: unknown[] }
    expect(body.embeds).toHaveLength(1)
    expect(fetch.requests[0]?.url).toContain('wait=true')
  })

  it('accepts a 204 with an empty body', async () => {
    const fetch = scriptedFetch([{ status: 204 }])
    const notifier = createDiscordWebhookNotifier({ fetch })
    const result = await notifier.send(WEBHOOK, alert)
    expect(result.ok).toBe(true)
    expect(result.messageId).toBeNull()
  })

  it('honours a fractional retry_after on a 429, and does not double-wait after it', async () => {
    const clock = fakeClock(0)
    const sleep = advancingSleep(clock)
    const fetch = scriptedFetch([
      { status: 429, body: { message: 'You are being rate limited.', retry_after: 0.75, global: false } },
      { status: 200, body: { id: '1' } },
    ])
    const notifier = createDiscordWebhookNotifier({ fetch, sleep, now: clock.now, limiter: createDiscordRateLimiter(clock.now, sleep) })
    const result = await notifier.send(WEBHOOK, alert)

    expect(result.ok).toBe(true)
    // Discord's retry_after is seconds as a float, unlike Telegram's integer.
    // Serving the penalty once satisfies the bucket the penalty created.
    expect(sleep.waits).toEqual([750])
  })

  it('waits out an exhausted bucket before the next request', async () => {
    const clock = fakeClock(0)
    const sleep = recordingSleep()
    const limiter = createDiscordRateLimiter(clock.now, sleep)
    const fetch = scriptedFetch([
      { status: 200, body: { id: '1' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' } },
      { status: 200, body: { id: '2' } },
    ])
    const notifier = createDiscordWebhookNotifier({ fetch, sleep, limiter })

    await notifier.send(WEBHOOK, alert)
    expect(sleep.waits).toEqual([])
    await notifier.send(WEBHOOK, alert)
    // The bucket said zero remaining for two seconds, so the second send waits
    // instead of spending a 429.
    expect(sleep.waits).toEqual([2_000])
  })

  it('applies a global 429 to every route', async () => {
    const clock = fakeClock(0)
    const sleep = recordingSleep()
    const limiter = createDiscordRateLimiter(clock.now, sleep)
    limiter.penalise('channel:1', 5_000, true)
    await limiter.acquire('channel:2')
    expect(sleep.waits).toEqual([5_000])
  })

  it('rejects a malformed webhook URL without an HTTP call', async () => {
    const fetch = scriptedFetch([{ status: 200, body: {} }])
    const notifier = createDiscordWebhookNotifier({ fetch })
    const result = await notifier.send('https://example.com/not-a-webhook', alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(fetch.requests).toHaveLength(0)
  })

  it('does not retry a permanent 404 from a deleted webhook', async () => {
    const sleep = recordingSleep()
    const fetch = scriptedFetch([{ status: 404, body: { message: 'Unknown Webhook', code: 10015 } }])
    const notifier = createDiscordWebhookNotifier({ fetch, sleep })
    const result = await notifier.send(WEBHOOK, alert)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.error).toBe('Unknown Webhook')
    expect(fetch.requests).toHaveLength(1)
  })

  it('posts to a channel with the bot token', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { id: '77' } }])
    const notifier = createDiscordBotNotifier({ botToken: 'bot-token', fetch })
    const result = await notifier.send('987654321098765432', alert)

    expect(result.ok).toBe(true)
    expect(fetch.requests[0]?.url).toContain('/channels/987654321098765432/messages')
    expect(fetch.requests[0]?.headers['authorization']).toBe('Bot bot-token')
  })

  it('rejects a non-snowflake channel id', async () => {
    const fetch = scriptedFetch([{ status: 200, body: {} }])
    const notifier = createDiscordBotNotifier({ botToken: 'bot-token', fetch })
    const result = await notifier.send('general', alert)
    expect(result.ok).toBe(false)
    expect(fetch.requests).toHaveLength(0)
  })
})

describe('capture notifier', () => {
  it('records instead of sending, and reports success', async () => {
    const capture = createCaptureNotifier('telegram')
    const result = await capture.send('123', alert)
    expect(result.ok).toBe(true)
    expect(capture.sent).toHaveLength(1)
    expect(capture.sent[0]?.alert.plain).toContain('Whale')
    capture.clear()
    expect(capture.sent).toHaveLength(0)
  })
})
