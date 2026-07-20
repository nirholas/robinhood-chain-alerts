/**
 * The bot: one command router, two front ends (Telegram long polling and
 * Discord slash commands over the HTTP interactions endpoint).
 *
 * @packageDocumentation
 */

export { COMMANDS, createCommandRouter } from './commands.js'
export type {
  CommandContext,
  CommandReply,
  CommandRouter,
  CommandRouterDeps,
  CommandSpec,
} from './commands.js'

export { createTelegramBot } from './telegram-bot.js'
export type { TelegramBot, TelegramBotOptions } from './telegram-bot.js'

export {
  CALLBACK_TYPE,
  EPHEMERAL_FLAG,
  INTERACTION_TYPE,
  createDiscordInteractionHandler,
  discordCommandDefinitions,
  registerDiscordCommands,
  verifyDiscordSignature,
} from './discord-bot.js'
export type {
  DiscordCommandDefinition,
  DiscordInteractionOptions,
  InteractionResponse,
  RegisterCommandsOptions,
} from './discord-bot.js'
