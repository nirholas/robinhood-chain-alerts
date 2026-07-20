import { z } from 'zod'
import type { LogLevel } from './logger.js'

/**
 * Service configuration, validated at startup.
 *
 * Every value is checked before anything connects: a malformed
 * `WHALE_MIN_USD` should fail in the first second with a clear message, not
 * three hours later as a `NaN` comparison that silently matched every swap.
 */

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue
      return /^(1|true|yes|on)$/i.test(value.trim())
    })

const int = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : Number(value)))
    .refine((value) => Number.isFinite(value) && value >= min && value <= max, {
      message: `must be a number between ${min} and ${max}`,
    })

const bigintValue = (defaultValue: bigint) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : BigInt(value.trim())))

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )

const addressValue = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed address')
  .optional()

const envSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet']).optional().default('mainnet'),
  ROBINHOOD_RPC_URL: z.string().url().optional(),
  DB_PATH: z.string().optional().default('./data/hood-alerts.sqlite'),
  PORT: int(8080, 1, 65535),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  DRY_RUN: bool(false),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_INTERACTIONS_PATH: z.string().optional().default('/discord/interactions'),

  POLL_INTERVAL_MS: int(3_000, 250, 600_000),
  FLUSH_INTERVAL_MS: int(1_000, 100, 600_000),
  CONFIRMATIONS: bigintValue(2n),
  CHUNK_SIZE: bigintValue(2_000n),
  INITIAL_LOOKBACK_BLOCKS: bigintValue(5_000n),

  WHALE_MIN_USD: int(1_000, 0, 1_000_000_000),
  WHALE_POOL_LIMIT: int(400, 1, 5_000),

  FLUSH_BATCH_SIZE: int(50, 1, 1_000),
  MAX_DELIVERY_ATTEMPTS: int(6, 1, 50),
  RETRY_BACKOFF_MS: int(30_000, 100, 3_600_000),
  OUTBOX_RETENTION_HOURS: int(72, 1, 8_760),

  ENTITLEMENTS: z.enum(['static', 'usdg', 'both']).optional().default('static'),
  PREMIUM_SUBSCRIBERS: csv,
  ALL_PREMIUM: bool(false),
  USDG_RECEIVER: addressValue,
  PREMIUM_PRICE_USDG: int(25, 1, 1_000_000),
  PREMIUM_PERIOD_DAYS: int(30, 1, 3_650),
  PAYMENTS_FROM_BLOCK: bigintValue(0n),
  UPGRADE_INSTRUCTIONS: z.string().optional(),
})

/** The validated service configuration. */
export interface ServiceConfig {
  network: 'mainnet' | 'testnet'
  rpcUrl: string | undefined
  dbPath: string
  port: number
  logLevel: LogLevel
  dryRun: boolean

  telegramBotToken: string | undefined
  discordBotToken: string | undefined
  discordApplicationId: string | undefined
  discordPublicKey: string | undefined
  discordInteractionsPath: string

  pollIntervalMs: number
  flushIntervalMs: number
  confirmations: bigint
  chunkSize: bigint
  initialLookbackBlocks: bigint

  whaleMinUsd: number
  whalePoolLimit: number

  flushBatchSize: number
  maxDeliveryAttempts: number
  retryBackoffMs: number
  outboxRetentionHours: number

  entitlements: 'static' | 'usdg' | 'both'
  premiumSubscribers: string[]
  allPremium: boolean
  usdgReceiver: `0x${string}` | undefined
  premiumPriceUsdg: number
  premiumPeriodDays: number
  paymentsFromBlock: bigint
  upgradeInstructions: string | undefined
}

/**
 * Load and validate configuration from the environment.
 *
 * @throws with every problem listed at once, so a misconfigured deployment
 * needs one fix round rather than one per variable.
 *
 * @example
 * ```ts
 * const config = loadConfig()
 * console.log(`watching ${config.network} with ${config.confirmations} confirmations`)
 * ```
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n  ')
    throw new Error(`hood-alerts: invalid configuration\n  ${detail}`)
  }
  const value = parsed.data

  if (value.ENTITLEMENTS !== 'static' && !value.USDG_RECEIVER) {
    throw new Error(
      'hood-alerts: ENTITLEMENTS=usdg (or both) needs USDG_RECEIVER, the address subscribers pay.',
    )
  }
  if (value.DISCORD_APPLICATION_ID && !value.DISCORD_PUBLIC_KEY) {
    throw new Error(
      'hood-alerts: DISCORD_APPLICATION_ID is set but DISCORD_PUBLIC_KEY is not. Interactions cannot be verified without it.',
    )
  }

  return {
    network: value.NETWORK,
    rpcUrl: value.ROBINHOOD_RPC_URL,
    dbPath: value.DB_PATH,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    dryRun: value.DRY_RUN,

    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    discordBotToken: value.DISCORD_BOT_TOKEN,
    discordApplicationId: value.DISCORD_APPLICATION_ID,
    discordPublicKey: value.DISCORD_PUBLIC_KEY,
    discordInteractionsPath: value.DISCORD_INTERACTIONS_PATH,

    pollIntervalMs: value.POLL_INTERVAL_MS,
    flushIntervalMs: value.FLUSH_INTERVAL_MS,
    confirmations: value.CONFIRMATIONS,
    chunkSize: value.CHUNK_SIZE,
    initialLookbackBlocks: value.INITIAL_LOOKBACK_BLOCKS,

    whaleMinUsd: value.WHALE_MIN_USD,
    whalePoolLimit: value.WHALE_POOL_LIMIT,

    flushBatchSize: value.FLUSH_BATCH_SIZE,
    maxDeliveryAttempts: value.MAX_DELIVERY_ATTEMPTS,
    retryBackoffMs: value.RETRY_BACKOFF_MS,
    outboxRetentionHours: value.OUTBOX_RETENTION_HOURS,

    entitlements: value.ENTITLEMENTS,
    premiumSubscribers: value.PREMIUM_SUBSCRIBERS,
    allPremium: value.ALL_PREMIUM,
    usdgReceiver: value.USDG_RECEIVER as `0x${string}` | undefined,
    premiumPriceUsdg: value.PREMIUM_PRICE_USDG,
    premiumPeriodDays: value.PREMIUM_PERIOD_DAYS,
    paymentsFromBlock: value.PAYMENTS_FROM_BLOCK,
    upgradeInstructions: value.UPGRADE_INSTRUCTIONS,
  }
}
