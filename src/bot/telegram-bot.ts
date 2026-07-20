import { createTelegramClient, type TelegramClient, type TelegramClientOptions } from '../notifiers/telegram.js'
import type { Logger } from '../service/logger.js'
import { createSilentLogger } from '../service/logger.js'
import type { CommandContext, CommandRouter } from './commands.js'

/**
 * The Telegram bot: long polling, because it needs no public URL, no TLS
 * certificate and no inbound firewall rule. A self-hoster runs the container
 * and the bot works; a webhook deployment would need all three before the
 * first `/start`.
 *
 * `getUpdates` is called with a long timeout, so the loop is idle rather than
 * busy between messages, and the offset is advanced past every update the loop
 * has handled so a restart never re-processes an old command.
 */

/** Options for {@link createTelegramBot}. */
export interface TelegramBotOptions extends TelegramClientOptions {
  router: CommandRouter
  logger?: Logger
  /** Reuse the notifier's client so both share one rate-limit path. */
  client?: TelegramClient
  /** Long-poll timeout in seconds. @defaultValue `30` */
  pollTimeoutSeconds?: number
  /** Persist the update offset so a restart resumes cleanly. */
  offsetStore?: { get(): number | null; set(offset: number): void }
}

/** A running bot. */
export interface TelegramBot {
  /** Poll once and handle whatever arrived. Returns how many updates it handled. */
  pollOnce(): Promise<number>
  /** Publish the command list so Telegram shows the `/` menu. */
  publishCommands(): Promise<boolean>
  /** Start the loop. Resolves when {@link TelegramBot.stop} is called. */
  start(): Promise<void>
  /** Stop the loop after the current poll. */
  stop(): void
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat?: { id: number }
    from?: { id: number; is_bot?: boolean }
  }
}

function parseCommand(text: string): { command: string; args: string[]; rest: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...tail] = trimmed.split(/\s+/)
  if (!head) return null
  return { command: head, args: tail, rest: trimmed.slice(head.length).trim() }
}

/**
 * Build the Telegram bot.
 *
 * @example
 * ```ts
 * const bot = createTelegramBot({ botToken: process.env.TELEGRAM_BOT_TOKEN!, router })
 * await bot.publishCommands()
 * await bot.start()
 * ```
 */
export function createTelegramBot(options: TelegramBotOptions): TelegramBot {
  const client = options.client ?? createTelegramClient(options)
  const logger = options.logger ?? createSilentLogger()
  const pollTimeout = options.pollTimeoutSeconds ?? 30
  let offset = options.offsetStore?.get() ?? 0
  let running = false

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const text = message?.text
    const chatId = message?.chat?.id
    const fromId = message?.from?.id
    if (!text || chatId === undefined || fromId === undefined || message?.from?.is_bot === true) return

    const parsed = parseCommand(text)
    if (!parsed) return

    const context: CommandContext = {
      subscriberId: `telegram:${fromId}`,
      platform: 'telegram',
      defaultTarget: String(chatId),
      args: parsed.args,
      rest: parsed.rest,
    }
    const reply = await options.router.handle(parsed.command, context)
    const response = await client.call('sendMessage', {
      chat_id: chatId,
      text: reply.html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    if (!response.ok) {
      logger.warn('telegram reply failed', {
        chatId,
        command: parsed.command,
        error: response.description,
      })
    }
  }

  return {
    async publishCommands(): Promise<boolean> {
      const response = await client.call('setMyCommands', {
        commands: options.router.commands.map((command) => ({
          command: command.name,
          description: command.description.slice(0, 256),
        })),
      })
      if (!response.ok) logger.warn('setMyCommands failed', { error: response.description })
      return response.ok
    },

    async pollOnce(): Promise<number> {
      const response = await client.call('getUpdates', {
        ...(offset > 0 ? { offset } : {}),
        timeout: pollTimeout,
        allowed_updates: ['message'],
      })
      if (!response.ok) {
        logger.warn('getUpdates failed', { error: response.description })
        return 0
      }
      const updates = Array.isArray(response.result) ? (response.result as TelegramUpdate[]) : []
      for (const update of updates) {
        try {
          await handleUpdate(update)
        } catch (error) {
          // One bad command must not stall the loop or replay forever: log it
          // and still advance past it.
          logger.error('telegram update handler threw', {
            updateId: update.update_id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        offset = update.update_id + 1
        options.offsetStore?.set(offset)
      }
      return updates.length
    },

    async start(): Promise<void> {
      running = true
      logger.info('telegram bot started', { offset })
      while (running) {
        try {
          await this.pollOnce()
        } catch (error) {
          logger.error('telegram poll failed', {
            error: error instanceof Error ? error.message : String(error),
          })
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
      logger.info('telegram bot stopped')
    },

    stop(): void {
      running = false
    },
  }
}
