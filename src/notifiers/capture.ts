import type { Platform } from '../rules/schema.js'
import { delivered, type DeliveryResult, type Notifier, type RenderedAlert } from './types.js'

/** One captured delivery. */
export interface CapturedDelivery {
  platform: Platform
  target: string
  alert: RenderedAlert
  atMs: number
}

/** A notifier that records deliveries instead of sending them. */
export interface CaptureNotifier extends Notifier {
  /** Everything captured so far, in order. */
  readonly sent: readonly CapturedDelivery[]
  /** Drop the captured history. */
  clear(): void
}

/**
 * A delivery adapter that records instead of sending.
 *
 * This is a first-class operating mode, not a stub: running the service with
 * `DRY_RUN=1` swaps the real adapters for this one, so an operator can point a
 * fresh deployment at mainnet and watch exactly which alerts *would* have gone
 * out, with the real rendered text, before handing it bot tokens. It is also
 * what the notifier tests assert against.
 *
 * @example
 * ```ts
 * const capture = createCaptureNotifier('telegram')
 * await capture.send('-1001234567890', renderAlert(event))
 * console.log(capture.sent[0]?.alert.text)
 * ```
 */
export function createCaptureNotifier(
  platform: Platform,
  onSend?: (delivery: CapturedDelivery) => void,
  now: () => number = Date.now,
): CaptureNotifier {
  const sent: CapturedDelivery[] = []
  return {
    platform,
    kind: 'capture',
    sent,
    clear(): void {
      sent.length = 0
    },
    async send(target: string, alert: RenderedAlert): Promise<DeliveryResult> {
      const delivery: CapturedDelivery = { platform, target, alert, atMs: now() }
      sent.push(delivery)
      onSend?.(delivery)
      return delivered(200, 1, `capture-${sent.length}`)
    },
  }
}
