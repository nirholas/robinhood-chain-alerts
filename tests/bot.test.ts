import { describe, expect, it } from 'vitest'
import { createCommandRouter, type CommandContext } from '../src/bot/commands.js'
import {
  createDiscordInteractionHandler,
  discordCommandDefinitions,
  verifyDiscordSignature,
} from '../src/bot/discord-bot.js'
import { COMMANDS } from '../src/bot/commands.js'
import { AlertStore } from '../src/service/store.js'
import { createEntitlementGate } from '../src/tiers/enforce.js'
import { createStaticEntitlementProvider } from '../src/tiers/entitlements.js'
import { addr, fakeClock } from './helpers.js'

function router(premium = false) {
  const clock = fakeClock(1_000_000)
  const store = new AlertStore(':memory:', clock.now)
  const gate = createEntitlementGate({
    provider: createStaticEntitlementProvider(premium ? { allPremium: true } : {}),
  })
  let counter = 0
  return {
    store,
    clock,
    instance: createCommandRouter({
      store,
      gate,
      now: clock.now,
      newId: () => `id-${++counter}`,
      upgradeInstructions: 'Pay 25 USDG to 0xabc and run /link.',
    }),
  }
}

const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  subscriberId: 'telegram:1',
  platform: 'telegram',
  defaultTarget: '123456',
  args: [],
  rest: '',
  ...overrides,
})

describe('bot commands', () => {
  it('answers /help with every command', async () => {
    const { instance } = router()
    const reply = await instance.handle('/help', context())
    for (const command of COMMANDS) expect(reply.text).toContain(command.name)
  })

  it('explains the NOXA lifecycle in /help so nobody waits for a NOXA graduation', async () => {
    const { instance } = router()
    const reply = await instance.handle('/help', context())
    expect(reply.text).toMatch(/NOXA lists instantly/)
  })

  it('subscribes with a starter rule set inside the tier limits', async () => {
    const { instance, store } = router()
    const reply = await instance.handle('/subscribe', context())
    expect(reply.text).toMatch(/Subscribed/)

    const subs = store.listSubscriptionsFor('telegram:1')
    expect(subs).toHaveLength(1)
    expect(subs[0]?.target).toBe('123456')
    // The free tier allows three rules, and none of the starters is a curve firehose.
    expect(subs[0]?.rules.length).toBeLessThanOrEqual(3)
    expect(subs[0]?.rules.some((rule) => rule.kinds.includes('curve_trade'))).toBe(false)
  })

  it('refuses a second free subscription with a reason and a way forward', async () => {
    const { instance } = router()
    await instance.handle('/subscribe', context())
    const reply = await instance.handle('/subscribe', context({ defaultTarget: '999' }))
    expect(reply.text).toMatch(/free tier allows 1 subscription/)
    expect(reply.text).toMatch(/\/upgrade/)
  })

  it('does not duplicate a subscription for the same target', async () => {
    const { instance, store } = router()
    await instance.handle('/subscribe', context())
    const reply = await instance.handle('/subscribe', context())
    expect(reply.text).toMatch(/already subscribed/)
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(1)
  })

  it('unsubscribes, and asks which one when there are several', async () => {
    const { instance, store } = router(true)
    await instance.handle('/subscribe', context())
    await instance.handle('/subscribe', context({ defaultTarget: '222' }))

    const ambiguous = await instance.handle('/unsubscribe', context())
    expect(ambiguous.text).toMatch(/Name the subscription/)
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(2)

    const removed = await instance.handle('/unsubscribe', context({ args: ['id-1'] }))
    expect(removed.text).toMatch(/Unsubscribed id-1/)
    expect(store.listSubscriptionsFor('telegram:1')).toHaveLength(1)
  })

  it('reports a missing subscription id instead of removing the wrong one', async () => {
    const { instance } = router(true)
    await instance.handle('/subscribe', context())
    await instance.handle('/subscribe', context({ defaultTarget: '222' }))
    const reply = await instance.handle('/unsubscribe', context({ args: ['nope'] }))
    expect(reply.text).toMatch(/No subscription with id "nope"/)
  })

  it('adds a rule from JSON', async () => {
    const { instance, store } = router(true)
    await instance.handle('/subscribe', context())
    const json = '{"id":"big","kinds":["whale_trade"],"minUsd":25000}'
    const reply = await instance.handle('/rule', context({ args: ['add', json], rest: `add ${json}` }))

    expect(reply.text).toMatch(/Rule added/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.some((rule) => rule.id === 'big')).toBe(true)
  })

  it('rejects malformed JSON with an example', async () => {
    const { instance } = router(true)
    await instance.handle('/subscribe', context())
    const reply = await instance.handle('/rule', context({ args: ['add', '{oops'], rest: 'add {oops' }))
    expect(reply.text).toMatch(/not valid JSON/)
    expect(reply.text).toMatch(/whale_trade/)
  })

  it('rejects an invalid rule with the field that failed', async () => {
    const { instance } = router(true)
    await instance.handle('/subscribe', context())
    const json = '{"id":"bad","minUsd":100,"maxUsd":1}'
    const reply = await instance.handle('/rule', context({ args: ['add', json], rest: `add ${json}` }))
    expect(reply.text).toMatch(/minUsd must not exceed maxUsd/)
  })

  it('rejects a rule the tier does not allow', async () => {
    const { instance } = router()
    await instance.handle('/subscribe', context())
    // Make room first, so the rejection is about the tier's event kinds and
    // not about the rule count.
    await instance.handle('/rule', context({ args: ['rm', 'launches'], rest: 'rm launches' }))
    const json = '{"id":"curve","kinds":["curve_trade"],"launchpads":["odyssey"]}'
    const reply = await instance.handle('/rule', context({ args: ['add', json], rest: `add ${json}` }))
    expect(reply.text).toMatch(/does not include curve_trade/)
  })

  it('rejects a duplicate rule id', async () => {
    const { instance } = router(true)
    await instance.handle('/subscribe', context())
    const json = '{"id":"launches","kinds":["launch"]}'
    const reply = await instance.handle('/rule', context({ args: ['add', json], rest: `add ${json}` }))
    expect(reply.text).toMatch(/already exists/)
  })

  it('removes, disables and re-enables a rule', async () => {
    const { instance, store } = router(true)
    await instance.handle('/subscribe', context())

    const off = await instance.handle('/rule', context({ args: ['off', 'launches'], rest: 'off launches' }))
    expect(off.text).toMatch(/disabled/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'launches')?.enabled).toBe(false)

    await instance.handle('/rule', context({ args: ['on', 'launches'], rest: 'on launches' }))
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'launches')?.enabled).toBe(true)

    const removed = await instance.handle('/rule', context({ args: ['rm', 'launches'], rest: 'rm launches' }))
    expect(removed.text).toMatch(/removed/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'launches')).toBeUndefined()
  })

  it('reports an unknown rule id on /rule rm', async () => {
    const { instance } = router(true)
    await instance.handle('/subscribe', context())
    const reply = await instance.handle('/rule', context({ args: ['rm', 'ghost'], rest: 'rm ghost' }))
    expect(reply.text).toMatch(/No rule with id "ghost"/)
  })

  it('sets a threshold and rejects a non-numeric one', async () => {
    const { instance, store } = router(true)
    await instance.handle('/subscribe', context())

    const ok = await instance.handle('/threshold', context({ args: ['whales', '12000'] }))
    expect(ok.text).toMatch(/at least \$12000/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'whales')?.minUsd).toBe(12_000)

    const bad = await instance.handle('/threshold', context({ args: ['whales', 'lots'] }))
    expect(bad.text).toMatch(/not a valid amount/)

    const missing = await instance.handle('/threshold', context({ args: ['ghost', '1'] }))
    expect(missing.text).toMatch(/No rule with id "ghost"/)

    const noArgs = await instance.handle('/threshold', context())
    expect(noArgs.text).toMatch(/Usage/)
  })

  it('adds and removes a watchlist token, and validates the address', async () => {
    const { instance, store } = router(true)
    await instance.handle('/subscribe', context())

    const added = await instance.handle('/watch', context({ args: [addr(5), 'launches'] }))
    expect(added.text).toMatch(/Watching/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'launches')?.tokens).toContain(
      addr(5).toLowerCase(),
    )

    const duplicate = await instance.handle('/watch', context({ args: [addr(5), 'launches'] }))
    expect(duplicate.text).toMatch(/already on rule/)

    const removed = await instance.handle('/unwatch', context({ args: [addr(5), 'launches'] }))
    expect(removed.text).toMatch(/Stopped watching/)

    const invalid = await instance.handle('/watch', context({ args: ['not-an-address'] }))
    expect(invalid.text).toMatch(/is not a token address/)
  })

  it('refuses a watchlist entry beyond the tier limit and leaves the rule unchanged', async () => {
    const { instance, store } = router()
    await instance.handle('/subscribe', context())
    for (let i = 1; i <= 5; i += 1) {
      await instance.handle('/watch', context({ args: [addr(i), 'launches'] }))
    }
    const denied = await instance.handle('/watch', context({ args: [addr(6), 'launches'] }))
    expect(denied.text).toMatch(/Cannot add/)
    expect(store.listSubscriptionsFor('telegram:1')[0]?.rules.find((r) => r.id === 'launches')?.tokens).toHaveLength(5)
  })

  it('reports the tier and its limits', async () => {
    const { instance } = router()
    const reply = await instance.handle('/tier', context())
    expect(reply.text).toMatch(/Tier: free/)
    expect(reply.text).toMatch(/Delivery delay: 60s/)
    expect(reply.text).toMatch(/premium only/)
  })

  it('reports status with the hourly cap', async () => {
    const { instance } = router()
    expect((await instance.handle('/status', context())).text).toMatch(/No subscriptions/)
    await instance.handle('/subscribe', context())
    const reply = await instance.handle('/status', context())
    expect(reply.text).toMatch(/1 subscription/)
    expect(reply.text).toMatch(/cap 30/)
  })

  it('walks through wallet linking and rejects a bad signature', async () => {
    const { instance, store } = router()
    const prompt = await instance.handle('/link', context())
    expect(prompt.text).toMatch(/Sign this message/)
    expect(store.getLinkNonce('telegram:1')).toBe('id-1')

    const bad = await instance.handle('/link', context({ args: [addr(3), `0x${'0'.repeat(130)}`] }))
    expect(bad.text).toMatch(/does not match/)

    const missingSignature = await instance.handle('/link', context({ args: [addr(3)] }))
    expect(missingSignature.text).toMatch(/Usage/)
  })

  it('links a wallet with a genuine signature', async () => {
    const { instance, store } = router()
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(`0x${'22'.repeat(32)}`)

    await instance.handle('/link', context())
    const nonce = store.getLinkNonce('telegram:1') as string
    const { linkMessage } = await import('../src/tiers/entitlements.js')
    const signature = await account.signMessage({ message: linkMessage('telegram:1', nonce) })

    const reply = await instance.handle('/link', context({ args: [account.address, signature] }))
    expect(reply.text).toMatch(/linked/)
    expect(await store.walletLinks().walletOf('telegram:1')).toBe(account.address)
    // The nonce is consumed, so the signature cannot be replayed.
    expect(store.getLinkNonce('telegram:1')).toBeNull()
  })

  it('shows upgrade instructions when the deployment sells premium', async () => {
    const { instance } = router()
    expect((await instance.handle('/upgrade', context())).text).toMatch(/25 USDG/)
  })

  it('answers an unknown command instead of going silent', async () => {
    const { instance } = router()
    const reply = await instance.handle('/nonsense', context())
    expect(reply.text).toMatch(/Unknown command/)
  })

  it('strips a @botname suffix from a group command', async () => {
    const { instance } = router()
    const reply = await instance.handle('/help@hood_alerts_bot', context())
    expect(reply.text).toMatch(/hood-alerts/)
  })

  it('tells the user to subscribe before editing rules', async () => {
    const { instance } = router()
    expect((await instance.handle('/rules', context())).text).toMatch(/no subscriptions/i)
    expect((await instance.handle('/threshold', context({ args: ['a', '1'] }))).text).toMatch(/Subscribe first/)
  })
})

describe('Discord slash commands', () => {
  it('produces definitions inside the API limits', () => {
    const definitions = discordCommandDefinitions(COMMANDS)
    expect(definitions).toHaveLength(COMMANDS.length)
    for (const definition of definitions) {
      expect(definition.description.length).toBeLessThanOrEqual(100)
      expect(definition.name).toMatch(/^[a-z]+$/)
      for (const option of definition.options ?? []) {
        expect(option.type).toBe(3)
        expect(option.description.length).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('Discord interaction verification', () => {
  it('rejects a malformed key, signature or timestamp without throwing', () => {
    expect(verifyDiscordSignature('nothex', 'a'.repeat(128), '1', '{}')).toBe(false)
    expect(verifyDiscordSignature('a'.repeat(64), 'short', '1', '{}')).toBe(false)
    expect(verifyDiscordSignature('a'.repeat(64), 'b'.repeat(128), '', '{}')).toBe(false)
  })

  it('verifies a genuine Ed25519 signature and rejects a tampered body', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')

    const timestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')

    expect(verifyDiscordSignature(raw, signature, timestamp, body)).toBe(true)
    expect(verifyDiscordSignature(raw, signature, timestamp, '{"type":2}')).toBe(false)
    expect(verifyDiscordSignature(raw, signature, '1700000001', body)).toBe(false)
  })

  it('answers a PING with a PONG and routes a command', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    const { instance } = router()
    const handler = createDiscordInteractionHandler({ router: instance, publicKey: raw })

    const send = async (payload: unknown) => {
      const rawBody = JSON.stringify(payload)
      const timestamp = '1700000000'
      const signature = sign(null, Buffer.from(timestamp + rawBody), privateKey).toString('hex')
      return handler.handle({ signature, timestamp, rawBody })
    }

    const ping = await send({ type: 1 })
    expect(ping.status).toBe(200)
    expect(ping.body).toEqual({ type: 1 })

    const command = await send({
      type: 2,
      guild_id: '999',
      channel_id: '888',
      member: { user: { id: '777' } },
      data: { name: 'help' },
    })
    expect(command.status).toBe(200)
    expect(JSON.stringify(command.body)).toContain('hood-alerts')
  })

  it('rejects an unsigned request with 401, which is what Discord validates against', async () => {
    const { instance } = router()
    const handler = createDiscordInteractionHandler({ router: instance, publicKey: 'a'.repeat(64) })
    const answer = await handler.handle({ signature: null, timestamp: null, rawBody: '{}' })
    expect(answer.status).toBe(401)
  })

  it('bills a guild once for all its channels', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    const { instance, store } = router()
    const handler = createDiscordInteractionHandler({ router: instance, publicKey: raw })

    const send = async (payload: unknown) => {
      const rawBody = JSON.stringify(payload)
      const timestamp = '1700000000'
      const signature = sign(null, Buffer.from(timestamp + rawBody), privateKey).toString('hex')
      return handler.handle({ signature, timestamp, rawBody })
    }

    await send({ type: 2, guild_id: '999', channel_id: '111', member: { user: { id: 'a' } }, data: { name: 'subscribe' } })
    const second = await send({
      type: 2,
      guild_id: '999',
      channel_id: '222',
      member: { user: { id: 'b' } },
      data: { name: 'subscribe' },
    })

    expect(store.listSubscriptionsFor('discord:999')).toHaveLength(1)
    expect(JSON.stringify(second.body)).toMatch(/free tier allows 1 subscription/)
  })
})
