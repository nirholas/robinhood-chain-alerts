import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpServer, renderMetrics, type HealthState } from '../src/service/http.js'
import { createSilentLogger } from '../src/service/logger.js'
import { createLogger } from '../src/service/logger.js'
import { AlertStore } from '../src/service/store.js'
import { loadConfig } from '../src/service/config.js'
import { parseRule, parseSubscription } from '../src/rules/schema.js'
import { fakeClock } from './helpers.js'

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

function harness(overrides: Partial<HealthState> = {}) {
  const clock = fakeClock(1_000_000)
  const store = new AlertStore(':memory:', clock.now)
  store.saveSubscription(
    parseSubscription({
      id: 'sub-1',
      subscriberId: 'telegram:1',
      platform: 'telegram',
      target: '123',
      rules: [parseRule({ id: 'r', kinds: ['launch'] })],
      createdAtMs: 0,
    }),
  )
  store.setCursor('noxa:launch', 900n)

  const health = (): HealthState => ({
    headBlock: 1_000n,
    lastPollAtMs: clock.now(),
    lastError: null,
    platforms: ['telegram'],
    version: '0.1.0',
    startedAtMs: clock.now() - 5_000,
    ...overrides,
  })

  const server = createHttpServer({ store, logger: createSilentLogger(), health, now: clock.now })
  closers.push(() => {
    server.close()
    store.close()
  })
  return { store, server, health, clock }
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('health and readiness', () => {
  it('reports health with the head block and platforms', async () => {
    const test = harness()
    const base = await listen(test.server)
    const response = await fetch(`${base}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(body['headBlock']).toBe('1000')
    expect(body['platforms']).toEqual(['telegram'])
  })

  it('is ready while the poller is fresh', async () => {
    const test = harness()
    const base = await listen(test.server)
    const response = await fetch(`${base}/ready`)
    expect(response.status).toBe(200)
  })

  it('is not ready when the poller has stalled, so an orchestrator can act', async () => {
    const test = harness({ lastPollAtMs: 1_000_000 - 500_000, lastError: 'rpc down' })
    const base = await listen(test.server)
    const response = await fetch(`${base}/ready`)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body['ready']).toBe(false)
    expect(body['lastError']).toBe('rpc down')
  })

  it('is not ready before the first poll completes', async () => {
    const test = harness({ lastPollAtMs: null })
    const base = await listen(test.server)
    expect((await fetch(`${base}/ready`)).status).toBe(503)
  })

  it('404s an unknown route with a message naming it', async () => {
    const test = harness()
    const base = await listen(test.server)
    const response = await fetch(`${base}/nope`)
    expect(response.status).toBe(404)
    expect((await response.json() as Record<string, string>)['error']).toContain('/nope')
  })
})

describe('metrics', () => {
  it('renders Prometheus text with cursor lag', () => {
    const test = harness()
    const body = renderMetrics(test.store, test.health(), test.clock.now())

    expect(body).toContain('hood_alerts_subscriptions{state="enabled"} 1')
    expect(body).toContain('hood_alerts_cursor_block{source="noxa:launch"} 900')
    expect(body).toContain('hood_alerts_head_block 1000')
    expect(body).toContain('hood_alerts_lag_blocks{source="noxa:launch"} 100')
    expect(body).toContain('hood_alerts_outbox{status="pending"} 0')
  })

  it('serves metrics with the Prometheus content type', async () => {
    const test = harness()
    const base = await listen(test.server)
    const response = await fetch(`${base}/metrics`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toContain('hood_alerts_uptime_seconds 5')
  })

  it('reports -1 for the poll age before the first poll rather than a fake zero', () => {
    const test = harness({ lastPollAtMs: null })
    expect(renderMetrics(test.store, test.health(), test.clock.now())).toContain(
      'hood_alerts_last_poll_age_seconds -1',
    )
  })
})

describe('discord interactions route', () => {
  it('404s when Discord is not configured', async () => {
    const test = harness()
    const base = await listen(test.server)
    const response = await fetch(`${base}/discord/interactions`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('passes the raw body and signature headers through untouched', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    let seen: { signature: string | null; timestamp: string | null; rawBody: string } | null = null
    const server = createHttpServer({
      store,
      logger: createSilentLogger(),
      health: () => ({
        headBlock: null,
        lastPollAtMs: null,
        lastError: null,
        platforms: [],
        version: '0.1.0',
        startedAtMs: clock.now(),
      }),
      now: clock.now,
      discord: {
        path: '/discord/interactions',
        handle: async (request) => {
          seen = request
          return { status: 200, body: { type: 1 } }
        },
      },
    })
    closers.push(() => {
      server.close()
      store.close()
    })

    const base = await listen(server)
    const rawBody = '{"type":1,"spacing":"  preserved  "}'
    const response = await fetch(`${base}/discord/interactions`, {
      method: 'POST',
      headers: {
        'x-signature-ed25519': 'a'.repeat(128),
        'x-signature-timestamp': '1700000000',
        'content-type': 'application/json',
      },
      body: rawBody,
    })

    expect(response.status).toBe(200)
    // Byte-for-byte: Ed25519 verification is over the exact bytes Discord sent.
    expect(seen!.rawBody).toBe(rawBody)
    expect(seen!.signature).toBe('a'.repeat(128))
    expect(seen!.timestamp).toBe('1700000000')
  })
})

describe('logger', () => {
  it('emits one JSON object per line with the base fields merged in', () => {
    const lines: string[] = []
    const logger = createLogger({ write: (line) => lines.push(line), base: { service: 'x' }, now: () => 0 })
    logger.info('hello', { count: 1 })

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(parsed['level']).toBe('info')
    expect(parsed['message']).toBe('hello')
    expect(parsed['service']).toBe('x')
    expect(parsed['count']).toBe(1)
    expect(parsed['time']).toBe('1970-01-01T00:00:00.000Z')
  })

  it('drops lines below the configured level', () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) })
    logger.debug('no')
    logger.info('no')
    logger.warn('yes')
    expect(lines).toHaveLength(1)
  })

  it('serializes bigints and errors instead of throwing inside a handler', () => {
    const lines: string[] = []
    const logger = createLogger({ write: (line) => lines.push(line) })
    expect(() => logger.error('failed', { block: 12n, error: new Error('boom') })).not.toThrow()

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(parsed['block']).toBe('12')
    expect((parsed['error'] as Record<string, string>)['message']).toBe('boom')
  })

  it('carries child context into every line', () => {
    const lines: string[] = []
    const logger = createLogger({ write: (line) => lines.push(line) }).child({ component: 'http' })
    logger.info('x')
    expect(JSON.parse(lines[0] as string)['component']).toBe('http')
  })
})

describe('configuration', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({})
    expect(config.network).toBe('mainnet')
    expect(config.port).toBe(8080)
    expect(config.confirmations).toBe(2n)
    expect(config.whaleMinUsd).toBe(1_000)
    expect(config.entitlements).toBe('static')
    expect(config.dryRun).toBe(false)
  })

  it('parses booleans, integers, bigints and lists', () => {
    const config = loadConfig({
      DRY_RUN: 'yes',
      PORT: '9000',
      CHUNK_SIZE: '5000',
      PREMIUM_SUBSCRIBERS: 'telegram:1, discord:2 ,',
    })
    expect(config.dryRun).toBe(true)
    expect(config.port).toBe(9_000)
    expect(config.chunkSize).toBe(5_000n)
    expect(config.premiumSubscribers).toEqual(['telegram:1', 'discord:2'])
  })

  it('rejects an out-of-range port with a readable message', () => {
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/PORT/)
  })

  it('rejects a USDG entitlement setup with no receiver', () => {
    expect(() => loadConfig({ ENTITLEMENTS: 'usdg' })).toThrow(/USDG_RECEIVER/)
  })

  it('rejects a Discord application with no public key to verify with', () => {
    expect(() => loadConfig({ DISCORD_APPLICATION_ID: '123' })).toThrow(/DISCORD_PUBLIC_KEY/)
  })

  it('accepts a complete USDG configuration', () => {
    const config = loadConfig({
      ENTITLEMENTS: 'both',
      USDG_RECEIVER: '0x0000000000000000000000000000000000000001',
      PREMIUM_PRICE_USDG: '25',
    })
    expect(config.entitlements).toBe('both')
    expect(config.premiumPriceUsdg).toBe(25)
  })
})
