import type { Server } from 'node:http'
import { createHoodClient, type HoodClient } from 'hoodchain'
import { createEventSources } from '../events/sources.js'
import { createLiquidityReader } from '../events/liquidity.js'
import { createPriceOracle } from '../events/pricing.js'
import { createTokenMetaReader } from '../events/tokens.js'
import { createCommandRouter } from '../bot/commands.js'
import { createDiscordInteractionHandler } from '../bot/discord-bot.js'
import { createTelegramBot, type TelegramBot } from '../bot/telegram-bot.js'
import { createCaptureNotifier } from '../notifiers/capture.js'
import { createDiscordBotNotifier, createDiscordWebhookNotifier } from '../notifiers/discord.js'
import { createTelegramClient, createTelegramNotifier } from '../notifiers/telegram.js'
import type { Notifier } from '../notifiers/types.js'
import { createRpcReputationProvider } from '../rules/reputation.js'
import type { Subscription } from '../rules/schema.js'
import { createEntitlementGate } from '../tiers/enforce.js'
import {
  chainEntitlementProviders,
  createStaticEntitlementProvider,
  createUsdgEntitlementProvider,
  type EntitlementProvider,
} from '../tiers/entitlements.js'
import type { ServiceConfig } from './config.js'
import { createDispatcher, type Dispatcher } from './dispatcher.js'
import { createHttpServer, type HealthState } from './http.js'
import { createLogger, type Logger } from './logger.js'
import { AlertStore } from './store.js'

/** Package version reported by `/health`. Kept in step with package.json. */
export const VERSION = '0.1.0'

/** A wired, runnable service. */
export interface AlertService {
  readonly config: ServiceConfig
  readonly store: AlertStore
  readonly dispatcher: Dispatcher
  readonly logger: Logger
  /** Current health snapshot. */
  health(): HealthState
  /** Start the HTTP server, the poll loop, the flush loop and the bots. */
  start(): Promise<void>
  /** Stop everything and close the database. Safe to call twice. */
  stop(): Promise<void>
}

/** Options for {@link createService}, all optional except the config. */
export interface CreateServiceOptions {
  config: ServiceConfig
  /** Substitute the chain client (a test double, or a pre-configured client). */
  client?: HoodClient
  /** Substitute the logger. */
  logger?: Logger
  /** Substitute the store (`:memory:` in tests). */
  store?: AlertStore
}

function buildEntitlements(
  config: ServiceConfig,
  client: HoodClient,
  store: AlertStore,
): EntitlementProvider {
  const staticProvider = createStaticEntitlementProvider({
    premiumSubscribers: config.premiumSubscribers,
    allPremium: config.allPremium,
  })
  if (config.entitlements === 'static') return staticProvider

  const usdgProvider = createUsdgEntitlementProvider({
    client,
    receiver: config.usdgReceiver as `0x${string}`,
    pricePerPeriodUsdg: config.premiumPriceUsdg,
    periodDays: config.premiumPeriodDays,
    links: store.walletLinks(),
    fromBlock: config.paymentsFromBlock,
  })
  if (config.entitlements === 'usdg') return usdgProvider
  // 'both': configuration grants comps, the chain sells subscriptions.
  return chainEntitlementProviders(staticProvider, usdgProvider)
}

/**
 * Wire the whole service from a validated configuration.
 *
 * @example
 * ```ts
 * import { createService, loadConfig } from 'hood-alerts/service'
 *
 * const service = createService({ config: loadConfig() })
 * await service.start()
 * ```
 */
export function createService(options: CreateServiceOptions): AlertService {
  const config = options.config
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, base: { service: 'hood-alerts' } })
  const client =
    options.client ??
    createHoodClient({
      chain: config.network,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    })
  const store = options.store ?? new AlertStore(config.dbPath)

  const oracle = createPriceOracle(client)
  const tokens = createTokenMetaReader(client)
  const registry = store.poolRegistry()
  const liquidity = createLiquidityReader(client, oracle, registry)
  const reputation = createRpcReputationProvider(client, oracle)

  const sources = createEventSources({
    client,
    oracle,
    tokens,
    registry,
    pinnedTokens: async () => store.watchlistTokens(),
    whaleMinUsd: config.whaleMinUsd,
    whalePoolLimit: config.whalePoolLimit,
  })

  const entitlements = buildEntitlements(config, client, store)
  const gate = createEntitlementGate({ provider: entitlements })

  // ---- notifiers ---------------------------------------------------------
  const platforms: string[] = []
  let telegramNotifier: Notifier | null = null
  let discordWebhookNotifier: Notifier | null = null
  let discordBotNotifier: Notifier | null = null
  const telegramClient = config.telegramBotToken
    ? createTelegramClient({ botToken: config.telegramBotToken })
    : null

  if (config.dryRun) {
    telegramNotifier = createCaptureNotifier('telegram', (delivery) =>
      logger.info('dry run: telegram alert', { target: delivery.target, text: delivery.alert.plain }),
    )
    discordWebhookNotifier = createCaptureNotifier('discord', (delivery) =>
      logger.info('dry run: discord alert', { target: delivery.target, text: delivery.alert.plain }),
    )
    discordBotNotifier = discordWebhookNotifier
    platforms.push('dry-run')
  } else {
    if (telegramClient) {
      telegramNotifier = createTelegramNotifier({
        botToken: config.telegramBotToken as string,
        client: telegramClient,
      })
      platforms.push('telegram')
    }
    // The webhook adapter needs no credential, so Discord webhook delivery is
    // always available even without a bot token.
    discordWebhookNotifier = createDiscordWebhookNotifier({})
    platforms.push('discord-webhook')
    if (config.discordBotToken) {
      discordBotNotifier = createDiscordBotNotifier({ botToken: config.discordBotToken })
      platforms.push('discord-bot')
    }
  }

  function notifierFor(subscription: Subscription): Notifier | null {
    if (subscription.platform === 'telegram') return telegramNotifier
    if (subscription.target.startsWith('https://')) return discordWebhookNotifier
    return discordBotNotifier
  }

  const dispatcher = createDispatcher({
    store,
    sources,
    gate,
    rateLimits: store.rateLimitStore(),
    notifierFor,
    getBlockNumber: () => client.public.getBlockNumber(),
    logger,
    evaluation: {
      liquidityUsd: (event) => liquidity.tokenLiquidityUsd(event.token),
      reputation: (deployer) => reputation.get(deployer),
      isLpLocked: (positionId) => reputation.isLpLocked(positionId),
    },
    confirmations: config.confirmations,
    chunkSize: config.chunkSize,
    initialLookbackBlocks: config.initialLookbackBlocks,
    flushBatchSize: config.flushBatchSize,
    maxDeliveryAttempts: config.maxDeliveryAttempts,
    retryBackoffMs: config.retryBackoffMs,
  })

  // ---- bot ---------------------------------------------------------------
  const router = createCommandRouter({
    store,
    gate,
    ...(config.upgradeInstructions ? { upgradeInstructions: config.upgradeInstructions } : {}),
  })

  let telegramBot: TelegramBot | null = null
  if (telegramClient && !config.dryRun) {
    telegramBot = createTelegramBot({
      botToken: config.telegramBotToken as string,
      client: telegramClient,
      router,
      logger: logger.child({ component: 'telegram-bot' }),
      offsetStore: {
        get: () => {
          const raw = store.getMeta('telegram:offset')
          return raw === null ? null : Number(raw)
        },
        set: (offset: number) => store.setMeta('telegram:offset', String(offset)),
      },
    })
  }

  const discordHandler = config.discordPublicKey
    ? createDiscordInteractionHandler({ router, publicKey: config.discordPublicKey })
    : null

  // ---- health ------------------------------------------------------------
  const startedAtMs = Date.now()
  let headBlock: bigint | null = null
  let lastPollAtMs: number | null = null
  let lastError: string | null = null

  const health = (): HealthState => ({
    headBlock,
    lastPollAtMs,
    lastError,
    platforms,
    version: VERSION,
    startedAtMs,
  })

  const server = createHttpServer({
    store,
    logger: logger.child({ component: 'http' }),
    health,
    ...(discordHandler
      ? { discord: { path: config.discordInteractionsPath, handle: discordHandler.handle } }
      : {}),
  })

  // ---- loops -------------------------------------------------------------
  let running = false
  const loops: Promise<void>[] = []
  let stopping: Promise<void> | null = null
  const waiters = new Set<() => void>()

  /** Sleep that resolves early when the service is stopping. */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(wake)
        resolve()
      }, ms)
      const wake = (): void => {
        clearTimeout(timer)
        waiters.delete(wake)
        resolve()
      }
      waiters.add(wake)
    })
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        headBlock = await client.public.getBlockNumber()
        const stats = await dispatcher.pollOnce()
        lastPollAtMs = Date.now()
        lastError = stats.errors.length > 0 ? (stats.errors[0]?.error ?? null) : null
        if (stats.eventsDecoded > 0 || stats.enqueued > 0) {
          logger.info('poll complete', {
            head: headBlock,
            events: stats.eventsDecoded,
            enqueued: stats.enqueued,
            deduped: stats.deduped,
            suppressed: stats.suppressed,
            errors: stats.errors.length,
          })
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        logger.error('poll loop error', { error: lastError })
      }
      await delay(config.pollIntervalMs)
    }
  }

  async function flushLoop(): Promise<void> {
    while (running) {
      try {
        const stats = await dispatcher.flushOnce()
        if (stats.claimed > 0) logger.debug('flush complete', { ...stats })
      } catch (error) {
        logger.error('flush loop error', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      await delay(config.flushIntervalMs)
    }
  }

  async function pruneLoop(): Promise<void> {
    while (running) {
      await delay(3_600_000)
      if (!running) break
      try {
        const cutoff = Date.now() - config.outboxRetentionHours * 3_600_000
        const outbox = store.pruneOutbox(cutoff)
        // Delivery history only needs to outlive the longest rate-limit window.
        const deliveries = store.pruneDeliveries(Date.now() - 25 * 3_600_000)
        if (outbox > 0 || deliveries > 0) logger.info('pruned', { outbox, deliveries })
      } catch (error) {
        logger.error('prune failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return {
    config,
    store,
    dispatcher,
    logger,
    health,

    async start(): Promise<void> {
      if (running) return
      running = true
      dispatcher.recover()

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(config.port, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })

      logger.info('service started', {
        port: config.port,
        network: config.network,
        dryRun: config.dryRun,
        platforms,
        entitlements: config.entitlements,
        sources: sources.map((source) => source.id),
      })

      loops.push(pollLoop(), flushLoop(), pruneLoop())
      if (telegramBot) {
        await telegramBot.publishCommands()
        loops.push(telegramBot.start())
      }
    },

    async stop(): Promise<void> {
      stopping ??= (async () => {
        logger.info('service stopping')
        running = false
        telegramBot?.stop()
        for (const wake of [...waiters]) wake()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Keep-alive sockets would otherwise hold the close open for a full
          // idle timeout on a shutdown that should take milliseconds.
          server.closeAllConnections?.()
        })
        await Promise.allSettled(loops)
        store.close()
        logger.info('service stopped')
      })()
      return stopping
    },
  }
}

/** A server handle, exported for tests that need the raw `node:http` server. */
export type { Server }
