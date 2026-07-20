import type { FetchLike, FetchLikeResponse } from './types.js'

/** A completed HTTP response with its body parsed as JSON when possible. */
export interface JsonResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  body: unknown
  raw: string
}

/** Default sleep. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/** Resolve the `fetch` to use: the injected double in tests, the global otherwise. */
export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('hood-alerts: global fetch is unavailable (Node 20+ required), and none was injected')
  }
  return globalThis.fetch as unknown as FetchLike
}

/**
 * POST JSON and parse the response.
 *
 * A non-JSON body (an HTML error page from a proxy, an empty 204) is not an
 * error here: `body` becomes `null` and `raw` keeps the text, so callers can
 * report what actually came back instead of a `SyntaxError` from deep inside
 * the adapter.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response: FetchLikeResponse = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  const raw = await response.text()
  let body: unknown = null
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, body, raw }
}

/** Read a numeric header, or `null` when absent or unparseable. */
export function numericHeader(
  headers: { get(name: string): string | null },
  name: string,
): number | null {
  const value = headers.get(name)
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Read a nested property from an unknown JSON body without casting blindly. */
export function pick(body: unknown, ...path: string[]): unknown {
  let current: unknown = body
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
