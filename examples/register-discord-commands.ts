/**
 * Register the bot's slash commands with Discord.
 *
 * Global registration can take up to an hour to propagate; passing a guild id
 * registers to that server immediately, which is what you want while testing.
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register:discord
 *   DISCORD_GUILD_ID=... npm run register:discord
 */
import { COMMANDS, registerDiscordCommands } from '../src/bot/index.js'

async function main(): Promise<void> {
  const applicationId = process.env['DISCORD_APPLICATION_ID']
  const botToken = process.env['DISCORD_BOT_TOKEN']
  if (!applicationId || !botToken) {
    console.error(
      'Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN. Both are on the application page at https://discord.com/developers/applications.',
    )
    process.exit(1)
  }

  const guildId = process.env['DISCORD_GUILD_ID']
  const count = await registerDiscordCommands(COMMANDS, {
    applicationId,
    botToken,
    ...(guildId ? { guildId } : {}),
  })

  console.log(
    `registered ${count} commands ${guildId ? `to guild ${guildId} (available immediately)` : 'globally (up to an hour to propagate)'}`,
  )
  for (const command of COMMANDS) console.log(`  /${command.name} - ${command.description}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
