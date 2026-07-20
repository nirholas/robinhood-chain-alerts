/**
 * hood-alerts: Telegram and Discord alert bots for Robinhood Chain memecoins
 * (chain ID 4663).
 *
 * Chain watching is `hoodchain` and `hoodkit`. This package is everything
 * above them: a normalized event taxonomy over both launchpads, a
 * schema-validated rule engine, rate-limit-correct delivery adapters, the bot
 * command surface, an enforced tier policy, and a restart-safe hosted service.
 *
 * @packageDocumentation
 */

export * from './events/index.js'
export * from './rules/index.js'
export * from './notifiers/index.js'
export * from './bot/index.js'
export * from './tiers/index.js'
export * from './service/index.js'
