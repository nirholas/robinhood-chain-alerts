import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { resolveFetch } from '../notifiers/http.js'
import type { FetchLike } from '../notifiers/types.js'
import { truncate } from '../notifiers/escape.js'
import type { CommandContext, CommandRouter, CommandSpec } from './commands.js'

/**
 * The Discord bot: slash commands over the HTTP interactions endpoint.
 *
 * Discord offers two ways to receive commands: a persistent gateway
 * WebSocket, or an HTTPS interactions endpoint. This package uses the
 * endpoint, because the service already runs an HTTP server for `/health` and
 * `/metrics`, and an endpoint scales to zero and survives a restart with no
 * reconnect logic. The price is that every request must be signature-verified,
 * which Discord enforces: it sends deliberately invalid signatures during
 * setup and refuses to save an endpoint that answers them with anything other
 * than `401`.
 *
 * Verification is Ed25519 over `timestamp + rawBody`, using the application's
 * public key. Node's `crypto` verifies Ed25519 natively, so this needs no
 * dependency: the raw 32-byte key is wrapped in the fixed SPKI DER prefix for
 * `id-Ed25519` (RFC 8410) and handed to `createPublicKey`.
 */

/** Discord's interaction type numbers, for the two kinds handled here. */
export const INTERACTION_TYPE = { PING: 1, APPLICATION_COMMAND: 2 } as const

/** Discord's interaction callback types. */
export const CALLBACK_TYPE = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 } as const

/** Discord marks a message ephemeral (only the caller sees it) with this flag. */
export const EPHEMERAL_FLAG = 1 << 6

/** RFC 8410 SPKI prefix for an Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Verify a Discord interaction signature.
 *
 * @param publicKey the application's hex public key from the developer portal.
 * @returns `true` only for a signature that verifies. Any malformed input is
 * `false`, never a throw: a crash here would answer Discord with a 500 and
 * fail its endpoint validation just as surely as a wrong answer.
 */
export function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  rawBody: string,
): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) return false
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) return false
  if (!timestamp) return false
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')]),
      format: 'der',
      type: 'spki',
    })
    return cryptoVerify(
      null,
      Buffer.from(timestamp + rawBody, 'utf8'),
      key,
      Buffer.from(signature, 'hex'),
    )
  } catch {
    return false
  }
}

/** A Discord slash-command definition, as the API expects it. */
export interface DiscordCommandDefinition {
  name: string
  description: string
  /** Option type 3 is STRING, the only type these commands need. */
  options?: { type: 3; name: string; description: string; required: boolean }[]
}

/** Convert the shared command catalogue into Discord slash-command definitions. */
export function discordCommandDefinitions(
  commands: readonly CommandSpec[],
): DiscordCommandDefinition[] {
  return commands.map((command) => ({
    name: command.name,
    // Discord caps descriptions at 100 characters and rejects the whole
    // registration if any one is longer.
    description: truncate(command.description, 100),
    ...(command.options && command.options.length > 0
      ? {
          options: command.options.map((option) => ({
            type: 3 as const,
            name: option.name,
            description: truncate(option.description, 100),
            required: option.required,
          })),
        }
      : {}),
  }))
}

/** Options for {@link registerDiscordCommands}. */
export interface RegisterCommandsOptions {
  applicationId: string
  botToken: string
  /** Register to one guild (instant) instead of globally (up to an hour to propagate). */
  guildId?: string
  apiBase?: string
  fetch?: FetchLike
}

/**
 * Register slash commands with Discord.
 *
 * @returns the number of commands Discord accepted.
 * @throws when Discord rejects the registration, with its own error message
 * attached: a silent failure here means a bot that appears installed and has
 * no commands.
 *
 * @example
 * ```bash
 * DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register:discord
 * ```
 */
export async function registerDiscordCommands(
  commands: readonly CommandSpec[],
  options: RegisterCommandsOptions,
): Promise<number> {
  const fetchImpl = resolveFetch(options.fetch)
  const apiBase = (options.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '')
  const url = options.guildId
    ? `${apiBase}/applications/${options.applicationId}/guilds/${options.guildId}/commands`
    : `${apiBase}/applications/${options.applicationId}/commands`

  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bot ${options.botToken}`,
    },
    body: JSON.stringify(discordCommandDefinitions(commands)),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`hood-alerts: Discord rejected the command registration (${response.status}): ${raw}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/** The shape of an incoming interaction, narrowed to what the router needs. */
interface Interaction {
  type: number
  guild_id?: string
  channel_id?: string
  member?: { user?: { id?: string } }
  user?: { id?: string }
  data?: {
    name?: string
    options?: { name: string; value?: unknown }[]
  }
}

/** What to answer Discord with. */
export interface InteractionResponse {
  status: number
  body: unknown
}

/** Options for {@link createDiscordInteractionHandler}. */
export interface DiscordInteractionOptions {
  router: CommandRouter
  /** The application's public key, for signature verification. */
  publicKey: string
  /** Reply only to the caller. @defaultValue `true` */
  ephemeral?: boolean
}

/**
 * Build the interactions handler. Mount it on the service's HTTP server at
 * whatever path is configured as the application's Interactions Endpoint URL.
 *
 * @example
 * ```ts
 * const interactions = createDiscordInteractionHandler({ router, publicKey })
 * // inside the HTTP server:
 * const answer = await interactions.handle({ signature, timestamp, rawBody })
 * res.writeHead(answer.status, { 'content-type': 'application/json' })
 * res.end(JSON.stringify(answer.body))
 * ```
 */
export function createDiscordInteractionHandler(options: DiscordInteractionOptions): {
  handle(request: { signature: string | null; timestamp: string | null; rawBody: string }): Promise<InteractionResponse>
} {
  const ephemeral = options.ephemeral ?? true

  return {
    async handle(request): Promise<InteractionResponse> {
      if (
        !request.signature ||
        !request.timestamp ||
        !verifyDiscordSignature(options.publicKey, request.signature, request.timestamp, request.rawBody)
      ) {
        return { status: 401, body: { error: 'invalid request signature' } }
      }

      let interaction: Interaction
      try {
        interaction = JSON.parse(request.rawBody) as Interaction
      } catch {
        return { status: 400, body: { error: 'body is not JSON' } }
      }

      if (interaction.type === INTERACTION_TYPE.PING) {
        return { status: 200, body: { type: CALLBACK_TYPE.PONG } }
      }
      if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) {
        return { status: 400, body: { error: `unsupported interaction type ${interaction.type}` } }
      }

      const name = interaction.data?.name
      if (!name) return { status: 400, body: { error: 'interaction carried no command name' } }

      const values = (interaction.data?.options ?? [])
        .map((option) => (option.value === undefined ? '' : String(option.value)))
        .filter((value) => value.length > 0)
      // A Discord option value can itself contain spaces (a JSON rule body, a
      // webhook URL), so the router receives the option values as separate
      // args and the joined string as `rest`.
      const rest = values.join(' ')
      const args = values.length === 1 ? (values[0] as string).split(/\s+/) : values

      const userId = interaction.member?.user?.id ?? interaction.user?.id ?? ''
      const context: CommandContext = {
        // A guild pays once for all its channels; a DM is billed to the user.
        subscriberId: `discord:${interaction.guild_id ?? userId}`,
        platform: 'discord',
        defaultTarget: interaction.channel_id ?? '',
        args,
        rest: `${name} ${rest}`.trim(),
      }

      const reply = await options.router.handle(name, context)
      return {
        status: 200,
        body: {
          type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            // Discord hard-caps message content at 2000 characters.
            content: truncate(reply.text, 1_900),
            ...(ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
          },
        },
      }
    },
  }
}
