import { randomUUID } from 'node:crypto'
import { getAddress } from 'viem'
import { escapeHtml } from '../notifiers/escape.js'
import {
  defaultRules,
  formatValidationError,
  parseSubscription,
  ruleComplexity,
  safeParseRule,
  type Platform,
  type Rule,
  type Subscription,
} from '../rules/schema.js'
import { linkMessage, verifyWalletLink } from '../tiers/entitlements.js'
import type { EntitlementGate } from '../tiers/enforce.js'
import type { AlertStore } from '../service/store.js'

/**
 * The bot's command surface, written once and shared by Telegram and Discord.
 *
 * Both platforms deliver the same thing to this router: a command name, a
 * subscriber id, a default delivery target and a list of arguments. Keeping
 * the logic here means the two bots cannot drift apart in what `/rule add`
 * accepts or what `/tier` reports, and it means the command tests exercise the
 * real code path rather than a Telegram-shaped copy of it.
 *
 * Every command answers bad input with a specific, actionable message. There
 * is no silent failure and no raw validation dump: a mistyped threshold gets
 * "usd must be a positive number, for example /threshold whales 5000".
 */

/** What a platform hands the router. */
export interface CommandContext {
  /** Stable identity for entitlements: `telegram:<user id>`, `discord:<guild or user id>`. */
  subscriberId: string
  platform: Platform
  /**
   * Where alerts would go if the user does not name a target: the Telegram
   * chat id, or the Discord channel id the command was used in.
   */
  defaultTarget: string
  /** Arguments after the command word. */
  args: string[]
  /** The whole argument string, for commands that take free-form JSON. */
  rest: string
}

/** A reply to render back to the user. */
export interface CommandReply {
  /** Telegram HTML, which Discord renders acceptably after tag stripping. */
  html: string
  /** Plain-text equivalent, used by Discord and by logs. */
  text: string
}

/** A command the bot exposes. */
export interface CommandSpec {
  name: string
  description: string
  /** Usage line shown by `/help` and in the README. */
  usage: string
  /** Discord slash-command options, when the command takes arguments. */
  options?: { name: string; description: string; required: boolean }[]
}

/** Everything the router needs. */
export interface CommandRouterDeps {
  store: AlertStore
  gate: EntitlementGate
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
  /** Id factory for new subscriptions and nonces. @defaultValue `randomUUID` */
  newId?: () => string
  /** Shown by `/upgrade`: how to pay. Set from the service config. */
  upgradeInstructions?: string
}

/** The router. */
export interface CommandRouter {
  /** Every command, for `/help` and for Discord registration. */
  readonly commands: readonly CommandSpec[]
  /** Handle one command. Never throws: errors come back as a reply. */
  handle(command: string, context: CommandContext): Promise<CommandReply>
}

const reply = (text: string): CommandReply => ({ html: escapeHtml(text), text })

const html = (htmlText: string, plain: string): CommandReply => ({ html: htmlText, text: plain })

/** The command catalogue. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'start', description: 'Set up alerts in this chat', usage: '/start' },
  { name: 'help', description: 'Show every command', usage: '/help' },
  {
    name: 'subscribe',
    description: 'Send alerts here, with a starter rule set',
    usage: '/subscribe [target]',
    options: [
      {
        name: 'target',
        description: 'Discord webhook URL or channel id. Defaults to this channel.',
        required: false,
      },
    ],
  },
  {
    name: 'unsubscribe',
    description: 'Stop alerts for a subscription',
    usage: '/unsubscribe [subscription id]',
    options: [{ name: 'id', description: 'Subscription id from /status', required: false }],
  },
  { name: 'rules', description: 'List your rules', usage: '/rules' },
  {
    name: 'rule',
    description: 'Add, remove, enable or disable a rule',
    usage: '/rule add <json> | /rule rm <id> | /rule on <id> | /rule off <id>',
    options: [{ name: 'input', description: 'add <json> | rm <id> | on <id> | off <id>', required: true }],
  },
  {
    name: 'threshold',
    description: 'Set a rule minimum USD value',
    usage: '/threshold <rule id> <usd>',
    options: [
      { name: 'rule', description: 'Rule id', required: true },
      { name: 'usd', description: 'Minimum USD value', required: true },
    ],
  },
  {
    name: 'watch',
    description: 'Add a token to a rule watchlist',
    usage: '/watch <token address> [rule id]',
    options: [
      { name: 'token', description: 'Token contract address', required: true },
      { name: 'rule', description: 'Rule id (defaults to the first rule)', required: false },
    ],
  },
  {
    name: 'unwatch',
    description: 'Remove a token from a rule watchlist',
    usage: '/unwatch <token address> [rule id]',
    options: [
      { name: 'token', description: 'Token contract address', required: true },
      { name: 'rule', description: 'Rule id (defaults to the first rule)', required: false },
    ],
  },
  { name: 'tier', description: 'Show your tier and its limits', usage: '/tier' },
  { name: 'status', description: 'Show your subscriptions and delivery state', usage: '/status' },
  {
    name: 'link',
    description: 'Link a paying wallet (signature verified)',
    usage: '/link [address] [signature]',
    options: [
      { name: 'address', description: 'Wallet address that pays', required: false },
      { name: 'signature', description: 'Signature of the link message', required: false },
    ],
  },
  { name: 'upgrade', description: 'How to go premium', usage: '/upgrade' },
]

function ruleSummary(rule: Rule): string {
  const parts = [
    `${rule.enabled ? 'on ' : 'off'} ${rule.id}`,
    rule.name ? `"${rule.name}"` : null,
    `kinds=${rule.kinds.join('/')}`,
    `pads=${rule.launchpads.join('/')}`,
    rule.minUsd !== undefined ? `minUsd=${rule.minUsd}` : null,
    rule.maxUsd !== undefined ? `maxUsd=${rule.maxUsd}` : null,
    rule.minLiquidityUsd !== undefined ? `minLiq=${rule.minLiquidityUsd}` : null,
    rule.maxLiquidityUsd !== undefined ? `maxLiq=${rule.maxLiquidityUsd}` : null,
    rule.side !== 'any' ? `side=${rule.side}` : null,
    rule.tokens.length > 0 ? `tokens=${rule.tokens.length}` : null,
    rule.deployers.length > 0 ? `deployers=${rule.deployers.length}` : null,
    rule.rateLimit ? `rate=${JSON.stringify(rule.rateLimit)}` : null,
    `filters=${ruleComplexity(rule)}`,
  ].filter((part): part is string => part !== null)
  return parts.join(' ')
}

/** Build the command router. */
export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID

  function subscriptionsOf(context: CommandContext): Subscription[] {
    return deps.store.listSubscriptionsFor(context.subscriberId)
  }

  function firstSubscription(context: CommandContext): Subscription | null {
    return subscriptionsOf(context)[0] ?? null
  }

  async function handleSubscribe(context: CommandContext): Promise<CommandReply> {
    const target = context.args[0]?.trim() || context.defaultTarget
    if (!target) {
      return reply(
        'I could not work out where to send alerts. Pass a target: /subscribe <discord webhook URL or channel id>',
      )
    }
    const existing = subscriptionsOf(context)
    if (existing.some((sub) => sub.target === target)) {
      return reply(`This target is already subscribed. Use /rules to edit it, or /unsubscribe to stop.`)
    }

    const decision = await deps.gate.checkAddSubscription(context.subscriberId, existing.length)
    if (!decision.allowed) return reply(`Cannot subscribe: ${decision.reason}`)

    const { policy } = await deps.gate.resolve(context.subscriberId)
    const rules = defaultRules().filter((rule) =>
      rule.kinds.every((kind) => policy.allowedKinds.includes(kind)),
    )
    const subscription = parseSubscription({
      id: newId(),
      subscriberId: context.subscriberId,
      platform: context.platform,
      target,
      enabled: true,
      rules: rules.slice(0, policy.maxRulesPerSubscription),
      createdAtMs: now(),
    })
    deps.store.saveSubscription(subscription)

    return html(
      [
        `<b>Subscribed.</b> Alerts will arrive here.`,
        `Subscription id: <code>${escapeHtml(subscription.id)}</code>`,
        `Tier: <b>${policy.tier}</b> (delivery delay ${policy.deliveryDelayMs / 1000}s, ${policy.maxAlertsPerHour} alerts/hour)`,
        '',
        'Starter rules:',
        ...subscription.rules.map((rule) => `• <code>${escapeHtml(ruleSummary(rule))}</code>`),
        '',
        'Edit them with /threshold, /watch and /rule. See /help.',
      ].join('\n'),
      `Subscribed. id=${subscription.id} tier=${policy.tier}`,
    )
  }

  async function handleUnsubscribe(context: CommandContext): Promise<CommandReply> {
    const subs = subscriptionsOf(context)
    if (subs.length === 0) return reply('You have no subscriptions. Use /subscribe to start one.')

    const id = context.args[0]?.trim()
    if (!id) {
      if (subs.length > 1) {
        return html(
          [
            'You have several subscriptions. Name the one to remove:',
            ...subs.map((sub) => `• <code>${escapeHtml(sub.id)}</code> → ${escapeHtml(sub.target)}`),
            '',
            'Usage: /unsubscribe &lt;subscription id&gt;',
          ].join('\n'),
          'Name the subscription to remove: ' + subs.map((sub) => sub.id).join(', '),
        )
      }
      const only = subs[0] as Subscription
      deps.store.deleteSubscription(only.id)
      return reply('Unsubscribed. No more alerts will be delivered here.')
    }

    const match = subs.find((sub) => sub.id === id)
    if (!match) return reply(`No subscription with id "${id}". Use /status to list yours.`)
    deps.store.deleteSubscription(match.id)
    return reply(`Unsubscribed ${match.id}.`)
  }

  function handleRules(context: CommandContext): CommandReply {
    const subs = subscriptionsOf(context)
    if (subs.length === 0) return reply('You have no subscriptions yet. Use /subscribe to start one.')
    const lines: string[] = []
    for (const sub of subs) {
      lines.push(`<b>${escapeHtml(sub.target)}</b> (<code>${escapeHtml(sub.id)}</code>)`)
      if (sub.rules.length === 0) lines.push('  no rules: nothing will be delivered')
      for (const rule of sub.rules) lines.push(`  • <code>${escapeHtml(ruleSummary(rule))}</code>`)
    }
    return html(lines.join('\n'), lines.join('\n').replace(/<[^>]+>/g, ''))
  }

  async function handleRule(context: CommandContext): Promise<CommandReply> {
    const action = context.args[0]?.toLowerCase()
    const subscription = firstSubscription(context)
    if (!subscription) return reply('Subscribe first with /subscribe, then add rules.')

    if (action === 'add') {
      const json = context.rest.slice(context.rest.indexOf('add') + 3).trim()
      if (!json) {
        return html(
          [
            'Usage: <code>/rule add {"id":"big-whales","kinds":["whale_trade"],"minUsd":25000}</code>',
            '',
            'Fields: id, name, enabled, kinds, launchpads, minUsd, maxUsd, minLiquidityUsd,',
            'maxLiquidityUsd, tokens, deployers, excludeDeployers, side, reputation, rateLimit.',
          ].join('\n'),
          'Usage: /rule add {"id":"big-whales","kinds":["whale_trade"],"minUsd":25000}',
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch {
        return reply('That is not valid JSON. Example: /rule add {"id":"whales","kinds":["whale_trade"],"minUsd":5000}')
      }
      const result = safeParseRule(parsed)
      if (!result.success) return reply(`Rule rejected: ${formatValidationError(result.error)}`)
      const rule = result.data

      if (subscription.rules.some((existing) => existing.id === rule.id)) {
        return reply(`A rule with id "${rule.id}" already exists. Remove it first with /rule rm ${rule.id}.`)
      }
      const decision = await deps.gate.checkAddRule(context.subscriberId, rule, subscription.rules.length)
      if (!decision.allowed) return reply(`Rule rejected: ${decision.reason}`)

      subscription.rules.push(rule)
      deps.store.saveSubscription(subscription)
      return html(
        `Rule added: <code>${escapeHtml(ruleSummary(rule))}</code>`,
        `Rule added: ${ruleSummary(rule)}`,
      )
    }

    if (action === 'rm' || action === 'remove' || action === 'delete') {
      const id = context.args[1]?.trim()
      if (!id) return reply('Usage: /rule rm <rule id>. List them with /rules.')
      const index = subscription.rules.findIndex((rule) => rule.id === id)
      if (index === -1) return reply(`No rule with id "${id}". List them with /rules.`)
      subscription.rules.splice(index, 1)
      deps.store.saveSubscription(subscription)
      return reply(`Rule ${id} removed.`)
    }

    if (action === 'on' || action === 'off') {
      const id = context.args[1]?.trim()
      if (!id) return reply(`Usage: /rule ${action} <rule id>. List them with /rules.`)
      const rule = subscription.rules.find((entry) => entry.id === id)
      if (!rule) return reply(`No rule with id "${id}". List them with /rules.`)
      rule.enabled = action === 'on'
      deps.store.saveSubscription(subscription)
      return reply(`Rule ${id} is now ${rule.enabled ? 'enabled' : 'disabled'}.`)
    }

    return html(
      [
        'Usage:',
        '• <code>/rule add {json}</code>',
        '• <code>/rule rm &lt;id&gt;</code>',
        '• <code>/rule on &lt;id&gt;</code>',
        '• <code>/rule off &lt;id&gt;</code>',
      ].join('\n'),
      'Usage: /rule add {json} | /rule rm <id> | /rule on <id> | /rule off <id>',
    )
  }

  async function handleThreshold(context: CommandContext): Promise<CommandReply> {
    const subscription = firstSubscription(context)
    if (!subscription) return reply('Subscribe first with /subscribe.')
    const [ruleId, rawUsd] = context.args
    if (!ruleId || !rawUsd) {
      return reply('Usage: /threshold <rule id> <usd>. Example: /threshold whales 5000')
    }
    const rule = subscription.rules.find((entry) => entry.id === ruleId)
    if (!rule) return reply(`No rule with id "${ruleId}". List them with /rules.`)
    const usd = Number(rawUsd)
    if (!Number.isFinite(usd) || usd < 0) {
      return reply(`"${rawUsd}" is not a valid amount. Use a positive number, for example /threshold ${ruleId} 5000`)
    }
    if (rule.maxUsd !== undefined && usd > rule.maxUsd) {
      return reply(`minUsd ${usd} would exceed this rule's maxUsd ${rule.maxUsd}. Lower it or raise maxUsd first.`)
    }
    rule.minUsd = usd
    const decision = await deps.gate.checkRule(context.subscriberId, rule)
    if (!decision.allowed) return reply(`Change rejected: ${decision.reason}`)
    deps.store.saveSubscription(subscription)
    return reply(`Rule ${ruleId} now requires at least $${usd} of value.`)
  }

  async function handleWatch(context: CommandContext, add: boolean): Promise<CommandReply> {
    const subscription = firstSubscription(context)
    if (!subscription) return reply('Subscribe first with /subscribe.')
    const rawToken = context.args[0]?.trim()
    if (!rawToken) {
      return reply(`Usage: /${add ? 'watch' : 'unwatch'} <token address> [rule id]`)
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(rawToken)) {
      return reply(`"${rawToken}" is not a token address. Pass the 0x contract address from the alert.`)
    }
    const token = getAddress(rawToken as `0x${string}`).toLowerCase()

    const ruleId = context.args[1]?.trim()
    const rule = ruleId
      ? subscription.rules.find((entry) => entry.id === ruleId)
      : subscription.rules[0]
    if (!rule) {
      return reply(
        ruleId ? `No rule with id "${ruleId}". List them with /rules.` : 'This subscription has no rules yet. Add one with /rule add.',
      )
    }

    if (add) {
      if (rule.tokens.includes(token)) return reply(`${rawToken} is already on rule ${rule.id}.`)
      rule.tokens.push(token)
      const decision = await deps.gate.checkRule(context.subscriberId, rule)
      if (!decision.allowed) {
        rule.tokens.pop()
        return reply(`Cannot add: ${decision.reason}`)
      }
      deps.store.saveSubscription(subscription)
      return reply(`Watching ${rawToken} on rule ${rule.id} (${rule.tokens.length} tokens).`)
    }

    const index = rule.tokens.indexOf(token)
    if (index === -1) return reply(`${rawToken} is not on rule ${rule.id}.`)
    rule.tokens.splice(index, 1)
    deps.store.saveSubscription(subscription)
    return reply(`Stopped watching ${rawToken} on rule ${rule.id}.`)
  }

  async function handleTier(context: CommandContext): Promise<CommandReply> {
    const { entitlement, policy } = await deps.gate.resolve(context.subscriberId)
    const expiry =
      entitlement.expiresAtMs === null
        ? 'no expiry'
        : `expires ${new Date(entitlement.expiresAtMs).toISOString()}`
    const lines = [
      `<b>Tier: ${escapeHtml(policy.tier)}</b> (${escapeHtml(expiry)}, source ${escapeHtml(entitlement.source)})`,
      `Subscriptions: up to ${policy.maxSubscriptions}`,
      `Rules per subscription: up to ${policy.maxRulesPerSubscription}`,
      `Filters per rule: up to ${policy.maxRuleComplexity}`,
      `Watchlist size: up to ${policy.maxWatchlistTokens}`,
      `Alerts per hour: up to ${policy.maxAlertsPerHour}`,
      `Delivery delay: ${policy.deliveryDelayMs / 1000}s`,
      `Liquidity and reputation filters: ${policy.allowOnChainLookupFilters ? 'included' : 'premium only'}`,
      `Event kinds: ${policy.allowedKinds.join(', ')}`,
    ]
    return html(lines.join('\n'), lines.join('\n').replace(/<[^>]+>/g, ''))
  }

  async function handleStatus(context: CommandContext): Promise<CommandReply> {
    const subs = subscriptionsOf(context)
    if (subs.length === 0) return reply('No subscriptions. Use /subscribe to start one.')
    const delivered = deps.store.countDeliveriesForSubscriber(context.subscriberId, now() - 3_600_000)
    const { policy } = await deps.gate.resolve(context.subscriberId)
    const lines = [
      `<b>${subs.length} subscription${subs.length === 1 ? '' : 's'}</b>, ${delivered} alerts in the last hour (cap ${policy.maxAlertsPerHour})`,
      ...subs.map(
        (sub) =>
          `• <code>${escapeHtml(sub.id)}</code> → ${escapeHtml(sub.target)} (${sub.rules.length} rules, ${sub.enabled ? 'enabled' : 'disabled'})`,
      ),
    ]
    return html(lines.join('\n'), lines.join('\n').replace(/<[^>]+>/g, ''))
  }

  async function handleLink(context: CommandContext): Promise<CommandReply> {
    const [address, signature] = context.args
    if (!address) {
      const nonce = deps.store.issueLinkNonce(context.subscriberId, newId())
      const message = linkMessage(context.subscriberId, nonce)
      return html(
        [
          'Sign this exact message with the wallet that pays, then send',
          `<code>/link &lt;address&gt; &lt;signature&gt;</code>`,
          '',
          `<pre>${escapeHtml(message)}</pre>`,
        ].join('\n'),
        `Sign this message and reply with /link <address> <signature>:\n${message}`,
      )
    }
    if (!signature) {
      return reply('Usage: /link <address> <signature>. Send /link on its own to get the message to sign.')
    }
    const nonce = deps.store.getLinkNonce(context.subscriberId)
    if (!nonce) {
      return reply('No pending link request. Send /link on its own first to get a fresh message to sign.')
    }
    const verified = await verifyWalletLink(context.subscriberId, nonce, address, signature)
    if (!verified) {
      return reply('That signature does not match. Sign the exact message from /link with the wallet you named.')
    }
    deps.store.linkWallet(context.subscriberId, verified)
    deps.store.clearLinkNonce(context.subscriberId)
    return reply(`Wallet ${verified} linked. Payments from it now count towards your subscription.`)
  }

  function handleUpgrade(): CommandReply {
    if (!deps.upgradeInstructions) {
      return reply(
        'This deployment does not sell premium access. The operator grants it through configuration; ask them.',
      )
    }
    return html(escapeHtml(deps.upgradeInstructions), deps.upgradeInstructions)
  }

  function handleHelp(): CommandReply {
    const header = 'hood-alerts: Robinhood Chain memecoin alerts.'
    const kinds = 'Event kinds: launch, curve_trade, graduation, whale_trade.'
    const lifecycle =
      'NOXA lists instantly (no bonding curve), so it never produces curve_trade or graduation. The Odyssey produces all four.'
    return html(
      [
        `<b>${escapeHtml(header)}</b>`,
        '',
        ...COMMANDS.map(
          (command) => `<code>${escapeHtml(command.usage)}</code> - ${escapeHtml(command.description)}`,
        ),
        '',
        escapeHtml(kinds),
        escapeHtml(lifecycle),
      ].join('\n'),
      [
        header,
        '',
        ...COMMANDS.map((command) => `${command.usage} - ${command.description}`),
        '',
        kinds,
        lifecycle,
      ].join('\n'),
    )
  }

  return {
    commands: COMMANDS,
    async handle(command: string, context: CommandContext): Promise<CommandReply> {
      const name = command.replace(/^\//, '').split('@')[0]?.toLowerCase() ?? ''
      try {
        switch (name) {
          case 'start':
          case 'help':
            return handleHelp()
          case 'subscribe':
            return await handleSubscribe(context)
          case 'unsubscribe':
            return await handleUnsubscribe(context)
          case 'rules':
            return handleRules(context)
          case 'rule':
            return await handleRule(context)
          case 'threshold':
            return await handleThreshold(context)
          case 'watch':
            return await handleWatch(context, true)
          case 'unwatch':
            return await handleWatch(context, false)
          case 'tier':
            return await handleTier(context)
          case 'status':
            return await handleStatus(context)
          case 'link':
            return await handleLink(context)
          case 'upgrade':
            return handleUpgrade()
          default:
            return reply(`Unknown command "${name}". Send /help for the list.`)
        }
      } catch (error) {
        // A handler throwing must still answer the user. Silence looks like a
        // dead bot, which is worse than an error message.
        const message = error instanceof Error ? error.message : String(error)
        return reply(`That command failed: ${message}. Try /help, or report this if it keeps happening.`)
      }
    },
  }
}
