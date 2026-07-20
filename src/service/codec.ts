import type { AlertEvent } from '../events/types.js'

/**
 * JSON codec for alert events.
 *
 * Events carry `bigint` block numbers and raw token amounts, which
 * `JSON.stringify` refuses to serialize. Coercing them to `number` would
 * silently lose precision on any amount above 2^53 (routine for an 18-decimal
 * token), so bigints are tagged and restored exactly.
 */

const BIGINT_TAG = '$bigint'

/** Serialize any value containing bigints. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) =>
    typeof raw === 'bigint' ? { [BIGINT_TAG]: raw.toString() } : raw,
  )
}

/** Restore a value serialized by {@link encode}. */
export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, raw: unknown) => {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      Object.keys(raw).length === 1 &&
      typeof (raw as Record<string, unknown>)[BIGINT_TAG] === 'string'
    ) {
      return BigInt((raw as Record<string, string>)[BIGINT_TAG] as string)
    }
    return raw
  }) as T
}

/** Serialize an alert event for the outbox. */
export function encodeEvent(event: AlertEvent): string {
  return encode(event)
}

/** Restore an alert event from the outbox. */
export function decodeEvent(text: string): AlertEvent {
  return decode<AlertEvent>(text)
}
