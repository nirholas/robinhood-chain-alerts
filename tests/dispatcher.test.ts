import { describe, expect, it } from 'vitest'
import type { EventSource } from '../src/events/sources.js'
import type { AlertEvent } from '../src/events/types.js'
import { createCaptureNotifier, type CaptureNotifier } from '../src/notifiers/capture.js'
import { parseRule, parseSubscription, type Subscription } from '../src/rules/schema.js'
import { createSilentLogger } from '../src/service/logger.js'
import { AlertStore } from '../src/service/store.js'
import { createDispatcher, type Dispatcher } from '../src/service/dispatcher.js'
import { createEntitlementGate } from '../src/tiers/enforce.js'
import { createStaticEntitlementProvider } from '../src/tiers/entitlements.js'
import { fakeClock, launchEvent, whaleTradeEvent } from './helpers.js'

/**
 * The restart tests. These are the reason the outbox and the cursor exist, so
 * they assert the exact guarantees the store documents: never double-send,
 * never silently skip, never lose an enqueued alert.
 */

interface Harness {
  store: AlertStore
  dispatcher: Dispatcher
  notifier: CaptureNotifier
  clock: ReturnType<typeof fakeClock>
  /** Blocks the source was asked for, in order. */
  polls: { from: bigint; to: bigint }[]
  head: () => bigint
  setHead(block: bigint): void
}

interface HarnessOptions {
  events: (from: bigint, to: bigint) => AlertEvent[]
  store?: AlertStore
  clock?: ReturnType<typeof fakeClock>
  subscription?: Subscription
  premium?: boolean
  failOnPoll?: () => boolean
  head?: bigint
  chunkSize?: bigint
  notifier?: CaptureNotifier
}

function subscriptionFixture(overrides: Partial<Subscription> = {}): Subscription {
  return parseSubscription({
    id: 'sub-1',
    subscriberId: 'telegram:1',
    platform: 'telegram',
    target: '123456',
    enabled: true,
    rules: [parseRule({ id: 'all-launches', kinds: ['launch', 'whale_trade'] })],
    createdAtMs: 0,
    ...overrides,
  })
}

function harness(options: HarnessOptions): Harness {
  const clock = options.clock ?? fakeClock(1_000_000)
  const store = options.store ?? new AlertStore(':memory:', clock.now)
  const notifier = options.notifier ?? createCaptureNotifier('telegram', undefined, clock.now)
  const polls: { from: bigint; to: bigint }[] = []
  let head = options.head ?? 10_000n

  if (store.listEnabledSubscriptions().length === 0) {
    store.saveSubscription(options.subscription ?? subscriptionFixture())
  }

  const source: EventSource = {
    id: 'test:source',
    label: 'test source',
    startBlock: 0n,
    async poll(from: bigint, to: bigint): Promise<AlertEvent[]> {
      polls.push({ from, to })
      if (options.failOnPoll?.()) throw new Error('rpc blew up mid-batch')
      return options.events(from, to)
    },
  }

  const gate = createEntitlementGate({
    provider: createStaticEntitlementProvider({ allPremium: options.premium ?? true }),
  })

  const dispatcher = createDispatcher({
    store,
    sources: [source],
    gate,
    rateLimits: store.rateLimitStore(),
    notifierFor: () => notifier,
    getBlockNumber: async () => head,
    logger: createSilentLogger(),
    confirmations: 0n,
    chunkSize: options.chunkSize ?? 1_000n,
    initialLookbackBlocks: 100n,
    now: clock.now,
    retryBackoffMs: 1_000,
    maxDeliveryAttempts: 3,
  })

  return {
    store,
    dispatcher,
    notifier,
    clock,
    polls,
    head: () => head,
    setHead(block: bigint) {
      head = block
    },
  }
}

describe('cursor semantics', () => {
  it('starts the initial lookback behind the head and advances after a poll', async () => {
    const test = harness({ events: () => [], head: 10_000n })
    await test.dispatcher.pollOnce()

    expect(test.polls[0]).toEqual({ from: 9_900n, to: 10_000n })
    expect(test.store.getCursor('test:source')).toBe(10_001n)
  })

  it('never re-reads a block it already processed', async () => {
    const test = harness({ events: () => [], head: 10_000n })
    await test.dispatcher.pollOnce()
    test.setHead(10_500n)
    await test.dispatcher.pollOnce()

    expect(test.polls[1]).toEqual({ from: 10_001n, to: 10_500n })
  })

  it('chunks a large backlog instead of asking for everything at once', async () => {
    const test = harness({ events: () => [], head: 50_000n, chunkSize: 1_000n })
    test.store.setCursor('test:source', 40_000n)
    await test.dispatcher.pollOnce()

    expect(test.polls[0]).toEqual({ from: 40_000n, to: 40_999n })
    // One chunk per pass, so a long backlog drains over several passes rather
    // than in one query the RPC would reject.
    expect(test.store.getCursor('test:source')).toBe(41_000n)
  })

  it('respects confirmations by refusing to process the unconfirmed tip', async () => {
    const store = new AlertStore(':memory:')
    store.saveSubscription(subscriptionFixture())
    const polls: { from: bigint; to: bigint }[] = []
    const dispatcher = createDispatcher({
      store,
      sources: [
        {
          id: 's',
          label: 's',
          startBlock: 0n,
          poll: async (from, to) => {
            polls.push({ from, to })
            return []
          },
        },
      ],
      gate: createEntitlementGate({ provider: createStaticEntitlementProvider({ allPremium: true }) }),
      rateLimits: store.rateLimitStore(),
      notifierFor: () => createCaptureNotifier('telegram'),
      getBlockNumber: async () => 1_000n,
      logger: createSilentLogger(),
      confirmations: 5n,
      initialLookbackBlocks: 10n,
    })
    await dispatcher.pollOnce()
    expect(polls[0]?.to).toBe(995n)
    store.close()
  })

  it('leaves the cursor untouched when a source throws, so nothing is skipped', async () => {
    let shouldFail = true
    const events = [launchEvent({ block: 9_950n, logIndex: 0 })]
    const test = harness({
      events: () => events,
      failOnPoll: () => shouldFail,
      head: 10_000n,
    })

    const first = await test.dispatcher.pollOnce()
    expect(first.errors).toHaveLength(1)
    expect(test.store.getCursor('test:source')).toBeNull()

    shouldFail = false
    const second = await test.dispatcher.pollOnce()
    expect(second.errors).toHaveLength(0)
    // The exact same range is retried, not the one after it.
    expect(test.polls[1]).toEqual(test.polls[0])
    expect(second.enqueued).toBe(1)
  })
})

describe('dedupe', () => {
  it('enqueues an event once even when the same range is processed twice', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    const event = launchEvent({ block: 9_950n })

    const first = harness({ events: () => [event], store, clock, head: 10_000n })
    const firstStats = await first.dispatcher.pollOnce()
    expect(firstStats.enqueued).toBe(1)

    // Force a replay of the same range, exactly as a crash-and-restart would.
    store.setCursor('test:source', 9_900n)
    const secondStats = await first.dispatcher.pollOnce()

    expect(secondStats.enqueued).toBe(0)
    expect(secondStats.deduped).toBe(1)
    expect(store.metrics().outbox.pending).toBe(1)
    store.close()
  })

  it('deduplicates a duplicate log inside a single batch', async () => {
    const event = launchEvent({ block: 9_950n })
    const test = harness({ events: () => [event, { ...event }], head: 10_000n })
    const stats = await test.dispatcher.pollOnce()

    expect(stats.enqueued).toBe(1)
    expect(stats.deduped).toBe(1)
  })

  it('treats two different log indexes in one transaction as two events', async () => {
    const test = harness({
      events: () => [launchEvent({ block: 9_950n, logIndex: 0 }), launchEvent({ block: 9_950n, logIndex: 1 })],
      head: 10_000n,
    })
    const stats = await test.dispatcher.pollOnce()
    expect(stats.enqueued).toBe(2)
  })
})

describe('crash recovery', () => {
  it('re-processes only the unfinished range after a crash mid-batch', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    const events = [
      launchEvent({ block: 9_950n, logIndex: 0 }),
      launchEvent({ block: 9_951n, logIndex: 1 }),
      launchEvent({ block: 9_952n, logIndex: 2 }),
    ]

    // A store whose third insert dies, standing in for the process being
    // killed part way through writing a batch.
    let inserts = 0
    const flaky = Object.create(store) as AlertStore
    flaky.enqueue = (row) => {
      inserts += 1
      if (inserts === 3) throw new Error('process killed')
      return store.enqueue(row)
    }

    const crashed = harness({ events: () => events, store: flaky, clock, head: 10_000n })
    const crashStats = await crashed.dispatcher.pollOnce()
    expect(crashStats.errors).toHaveLength(1)
    expect(store.getCursor('test:source')).toBeNull()
    expect(store.metrics().outbox.pending).toBe(2)

    // Restart: a fresh dispatcher over the same database.
    const restarted = harness({ events: () => events, store, clock, head: 10_000n })
    const stats = await restarted.dispatcher.pollOnce()

    expect(stats.enqueued).toBe(1)
    expect(stats.deduped).toBe(2)
    expect(store.metrics().outbox.pending).toBe(3)

    // And every alert is delivered exactly once.
    await restarted.dispatcher.flushOnce()
    expect(restarted.notifier.sent).toHaveLength(3)
    const ids = restarted.notifier.sent.map((delivery) => delivery.alert.plain)
    expect(new Set(ids).size).toBe(3)
    store.close()
  })

  it('returns rows abandoned in flight to the queue on restart', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    const test = harness({ events: () => [launchEvent({ block: 9_950n })], store, clock, head: 10_000n })
    await test.dispatcher.pollOnce()

    // Claim without delivering: the process died between claim and send.
    const claimed = store.claimDue(clock.now(), 10)
    expect(claimed).toHaveLength(1)
    expect(store.metrics().outbox.sending).toBe(1)

    const restarted = harness({ events: () => [], store, clock, head: 10_000n })
    expect(restarted.dispatcher.recover()).toBe(1)
    expect(store.metrics().outbox.pending).toBe(1)

    await restarted.dispatcher.flushOnce()
    expect(restarted.notifier.sent).toHaveLength(1)
    expect(store.metrics().outbox.sent).toBe(1)
    store.close()
  })

  it('persists the cursor across a restart', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    const first = harness({ events: () => [], store, clock, head: 10_000n })
    await first.dispatcher.pollOnce()

    const second = harness({ events: () => [], store, clock, head: 10_400n })
    await second.dispatcher.pollOnce()
    expect(second.polls[0]).toEqual({ from: 10_001n, to: 10_400n })
    store.close()
  })
})

describe('delivery', () => {
  it('delivers a matched alert and marks it sent', async () => {
    const test = harness({ events: () => [launchEvent({ block: 9_950n })], head: 10_000n })
    await test.dispatcher.pollOnce()
    const stats = await test.dispatcher.flushOnce()

    expect(stats.sent).toBe(1)
    expect(test.notifier.sent).toHaveLength(1)
    expect(test.store.metrics().outbox.sent).toBe(1)
  })

  it('holds a free-tier alert for the tier delay, then delivers it', async () => {
    const clock = fakeClock(1_000_000)
    const test = harness({
      events: () => [launchEvent({ block: 9_950n })],
      head: 10_000n,
      premium: false,
      clock,
    })
    await test.dispatcher.pollOnce()

    expect((await test.dispatcher.flushOnce()).claimed).toBe(0)
    clock.advance(60_001)
    expect((await test.dispatcher.flushOnce()).sent).toBe(1)
  })

  it('delivers a premium alert immediately', async () => {
    const test = harness({ events: () => [launchEvent({ block: 9_950n })], head: 10_000n, premium: true })
    await test.dispatcher.pollOnce()
    expect((await test.dispatcher.flushOnce()).sent).toBe(1)
  })

  it('retries a retryable failure with backoff and dead-letters after the attempt budget', async () => {
    const clock = fakeClock(1_000_000)
    const failing = createCaptureNotifier('telegram')
    const alwaysFails: typeof failing = {
      ...failing,
      send: async () => ({ ok: false, status: 500, attempts: 1, messageId: null, error: 'boom', retryable: true }),
    }
    const test = harness({
      events: () => [launchEvent({ block: 9_950n })],
      head: 10_000n,
      clock,
      notifier: alwaysFails as CaptureNotifier,
    })
    await test.dispatcher.pollOnce()

    expect((await test.dispatcher.flushOnce()).retried).toBe(1)
    expect(test.store.metrics().outbox.failed).toBe(1)

    // Backoff: the row is not due yet.
    expect((await test.dispatcher.flushOnce()).claimed).toBe(0)
    clock.advance(1_001)
    expect((await test.dispatcher.flushOnce()).retried).toBe(1)
    clock.advance(2_001)
    expect((await test.dispatcher.flushOnce()).dead).toBe(1)
    expect(test.store.metrics().outbox.dead).toBe(1)
  })

  it('dead-letters a permanent failure on the first attempt', async () => {
    const base = createCaptureNotifier('telegram')
    const rejected: typeof base = {
      ...base,
      send: async () => ({
        ok: false,
        status: 403,
        attempts: 1,
        messageId: null,
        error: 'bot was blocked by the user',
        retryable: false,
      }),
    }
    const test = harness({
      events: () => [launchEvent({ block: 9_950n })],
      head: 10_000n,
      notifier: rejected as CaptureNotifier,
    })
    await test.dispatcher.pollOnce()
    expect((await test.dispatcher.flushOnce()).dead).toBe(1)
  })

  it('dead-letters a delivery whose subscription was removed', async () => {
    const test = harness({ events: () => [launchEvent({ block: 9_950n })], head: 10_000n })
    await test.dispatcher.pollOnce()
    test.store.deleteSubscription('sub-1')
    expect((await test.dispatcher.flushOnce()).dead).toBe(1)
  })
})

describe('tier enforcement during dispatch', () => {
  it('suppresses an event kind the tier does not include, even if a rule asks for it', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    store.saveSubscription(
      subscriptionFixture({
        rules: [parseRule({ id: 'curve', kinds: ['curve_trade'], launchpads: ['odyssey'] })],
      }),
    )
    const test = harness({
      events: () => [
        {
          ...launchEvent({ block: 9_950n }),
          kind: 'curve_trade',
          launchpad: 'odyssey',
        } as unknown as AlertEvent,
      ],
      store,
      clock,
      head: 10_000n,
      premium: false,
    })
    const stats = await test.dispatcher.pollOnce()
    expect(stats.enqueued).toBe(0)
    expect(stats.suppressed).toBe(1)
    store.close()
  })

  it('caps a subscriber at the tier hourly throughput', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    store.saveSubscription(subscriptionFixture())
    const events: AlertEvent[] = Array.from({ length: 35 }, (_unused, index) =>
      whaleTradeEvent({ block: BigInt(9_900 + index), logIndex: index }),
    )
    const test = harness({ events: () => events, store, clock, head: 10_000n, premium: false })

    const stats = await test.dispatcher.pollOnce()
    // The free tier allows 30 alerts an hour.
    expect(stats.enqueued).toBe(30)
    expect(stats.suppressed).toBe(5)
    store.close()
  })

  it('enforces a rule rate limit', async () => {
    const clock = fakeClock(1_000_000)
    const store = new AlertStore(':memory:', clock.now)
    store.saveSubscription(
      subscriptionFixture({
        rules: [parseRule({ id: 'slow', kinds: ['whale_trade'], rateLimit: { maxPerHour: 2 } })],
      }),
    )
    const events: AlertEvent[] = Array.from({ length: 5 }, (_unused, index) =>
      whaleTradeEvent({ block: BigInt(9_900 + index), logIndex: index }),
    )
    const test = harness({ events: () => events, store, clock, head: 10_000n })

    const stats = await test.dispatcher.pollOnce()
    expect(stats.enqueued).toBe(2)
    expect(stats.suppressed).toBe(3)
    store.close()
  })
})
