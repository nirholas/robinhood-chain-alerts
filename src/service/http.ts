import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AlertStore } from './store.js'
import type { Logger } from './logger.js'

/**
 * The service's HTTP surface: `/health`, `/ready`, `/metrics`, and the Discord
 * interactions endpoint when Discord is configured.
 *
 * Kept on `node:http` deliberately. The whole surface is four routes, and a
 * framework would add a dependency, a middleware stack and a body parser that
 * mangles the raw request body, which Discord's signature verification needs
 * byte for byte.
 */

/** Liveness and readiness detail. */
export interface HealthState {
  /** Head block the poller last saw. `null` before the first successful poll. */
  headBlock: bigint | null
  /** When the poller last completed a pass, ms since epoch. */
  lastPollAtMs: number | null
  /** Last poll error, if the most recent pass failed. */
  lastError: string | null
  /** Which notifier platforms are configured. */
  platforms: string[]
  /** Version reported by `/health`. */
  version: string
  /** Process start time, ms since epoch. */
  startedAtMs: number
}

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  store: AlertStore
  logger: Logger
  /** Live health snapshot, read per request. */
  health: () => HealthState
  /**
   * Discord interactions handler, mounted at `interactionsPath`. Omitted when
   * Discord is not configured, in which case the path 404s.
   */
  discord?: {
    path: string
    handle(request: {
      signature: string | null
      timestamp: string | null
      rawBody: string
    }): Promise<{ status: number; body: unknown }>
  }
  /**
   * How stale the last successful poll may be before `/ready` reports 503, in
   * ms. @defaultValue `120_000`
   */
  readinessStalenessMs?: number
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limitBytes) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Render Prometheus text-format metrics. */
export function renderMetrics(store: AlertStore, health: HealthState, nowMs: number): string {
  const metrics = store.metrics()
  const lines: string[] = [
    '# HELP hood_alerts_subscriptions Subscriptions by state.',
    '# TYPE hood_alerts_subscriptions gauge',
    `hood_alerts_subscriptions{state="total"} ${metrics.subscriptions}`,
    `hood_alerts_subscriptions{state="enabled"} ${metrics.enabledSubscriptions}`,
    '# HELP hood_alerts_outbox Deliveries by outbox status.',
    '# TYPE hood_alerts_outbox gauge',
  ]
  for (const [status, count] of Object.entries(metrics.outbox)) {
    lines.push(`hood_alerts_outbox{status="${status}"} ${count}`)
  }
  lines.push(
    '# HELP hood_alerts_deliveries_last_hour Alerts delivered in the last rolling hour.',
    '# TYPE hood_alerts_deliveries_last_hour gauge',
    `hood_alerts_deliveries_last_hour ${metrics.deliveriesLastHour}`,
    '# HELP hood_alerts_pools Memecoin pools tracked for whale trades.',
    '# TYPE hood_alerts_pools gauge',
    `hood_alerts_pools ${metrics.pools}`,
    '# HELP hood_alerts_cursor_block Next unprocessed block per source.',
    '# TYPE hood_alerts_cursor_block gauge',
  )
  for (const cursor of metrics.cursors) {
    lines.push(`hood_alerts_cursor_block{source="${cursor.sourceId}"} ${cursor.nextBlock}`)
  }
  lines.push(
    '# HELP hood_alerts_head_block Chain head block last observed.',
    '# TYPE hood_alerts_head_block gauge',
    `hood_alerts_head_block ${health.headBlock ?? 0}`,
    '# HELP hood_alerts_lag_blocks How far each source trails the chain head.',
    '# TYPE hood_alerts_lag_blocks gauge',
  )
  if (health.headBlock !== null) {
    for (const cursor of metrics.cursors) {
      const lag = health.headBlock > cursor.nextBlock ? health.headBlock - cursor.nextBlock : 0n
      lines.push(`hood_alerts_lag_blocks{source="${cursor.sourceId}"} ${lag}`)
    }
  }
  lines.push(
    '# HELP hood_alerts_last_poll_age_seconds Seconds since the last successful poll.',
    '# TYPE hood_alerts_last_poll_age_seconds gauge',
    `hood_alerts_last_poll_age_seconds ${
      health.lastPollAtMs === null ? -1 : Math.round((nowMs - health.lastPollAtMs) / 1000)
    }`,
    '# HELP hood_alerts_uptime_seconds Process uptime.',
    '# TYPE hood_alerts_uptime_seconds counter',
    `hood_alerts_uptime_seconds ${Math.round((nowMs - health.startedAtMs) / 1000)}`,
    '',
  )
  return lines.join('\n')
}

/** Build the HTTP server. Call `listen` yourself so startup order stays explicit. */
export function createHttpServer(options: HttpServerOptions): Server {
  const now = options.now ?? Date.now
  const stalenessMs = options.readinessStalenessMs ?? 120_000

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      try {
        if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
          const health = options.health()
          json(res, 200, {
            ok: true,
            version: health.version,
            uptimeSeconds: Math.round((now() - health.startedAtMs) / 1000),
            headBlock: health.headBlock,
            lastPollAtMs: health.lastPollAtMs,
            lastError: health.lastError,
            platforms: health.platforms,
          })
          return
        }

        if (req.method === 'GET' && path === '/ready') {
          const health = options.health()
          // Ready means "ingesting": a service whose poller died is alive but
          // useless, and reporting it ready would hide the outage from an
          // orchestrator that could restart it.
          const fresh =
            health.lastPollAtMs !== null && now() - health.lastPollAtMs <= stalenessMs
          json(res, fresh ? 200 : 503, {
            ready: fresh,
            lastPollAtMs: health.lastPollAtMs,
            lastError: health.lastError,
          })
          return
        }

        if (req.method === 'GET' && path === '/metrics') {
          const body = renderMetrics(options.store, options.health(), now())
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
          res.end(body)
          return
        }

        if (options.discord && req.method === 'POST' && path === options.discord.path) {
          const rawBody = await readBody(req, 256 * 1024)
          if (rawBody === null) {
            json(res, 413, { error: 'request body too large' })
            return
          }
          const answer = await options.discord.handle({
            signature: req.headers['x-signature-ed25519'] as string | undefined ?? null,
            timestamp: req.headers['x-signature-timestamp'] as string | undefined ?? null,
            rawBody,
          })
          json(res, answer.status, answer.body)
          return
        }

        json(res, 404, { error: `no route for ${req.method ?? 'GET'} ${path}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.logger.error('http handler failed', { path, error: message })
        if (!res.headersSent) json(res, 500, { error: 'internal error' })
        else res.end()
      }
    })()
  })
}
