import { getAddress, verifyMessage, type Address } from 'viem'
import { USDG_DECIMALS, erc20Abi, type HoodClient } from 'hoodchain'
import { formatUnits } from 'viem'
import { fetchLogRange, type FetchLogRangeOptions } from '../events/logs.js'
import type { Tier } from './policy.js'

/**
 * Entitlements: who is premium, and why.
 *
 * The service resolves a subscriber's tier through exactly one interface, so
 * there is a single place to audit and a single place to swap the commercial
 * model. Two implementations ship:
 *
 * 1. {@link createStaticEntitlementProvider} is the documented default. Premium
 *    subscribers come from configuration (`PREMIUM_SUBSCRIBERS` in the
 *    environment). It has no dependencies, works offline, and is what a
 *    self-hoster running the bot for their own community wants.
 * 2. {@link createUsdgEntitlementProvider} is a working on-chain rail. It reads
 *    USDG `Transfer` logs to the operator's receiving address from a wallet
 *    the subscriber has linked, and accrues subscription time from those real
 *    payments. It needs no facilitator, no card processor and no third-party
 *    service: USDG is the chain's own dollar and the ledger is the chain.
 *
 * Wallet linking is signature-verified (EIP-191 `personal_sign` over a
 * server-issued nonce), so a subscriber cannot claim someone else's payments
 * by pasting their address.
 */

/** A resolved entitlement. */
export interface Entitlement {
  subscriberId: string
  tier: Tier
  /** When premium lapses, ms since epoch. `null` for free or for a permanent grant. */
  expiresAtMs: number | null
  /** Which provider decided this, for support and for `/tier`. */
  source: string
}

/** The single entitlement chokepoint. */
export interface EntitlementProvider {
  /** Resolve a subscriber's tier. Must never throw: fall back to free. */
  get(subscriberId: string): Promise<Entitlement>
}

const free = (subscriberId: string, source: string): Entitlement => ({
  subscriberId,
  tier: 'free',
  expiresAtMs: null,
  source,
})

/**
 * Configuration-driven entitlements: the documented default.
 *
 * @example
 * ```ts
 * const entitlements = createStaticEntitlementProvider({
 *   premiumSubscribers: ['telegram:12345', 'discord:987654321'],
 * })
 * ```
 */
export function createStaticEntitlementProvider(options: {
  premiumSubscribers?: readonly string[]
  /** Treat everyone as premium. For a private self-hosted deployment. */
  allPremium?: boolean
}): EntitlementProvider {
  const premium = new Set((options.premiumSubscribers ?? []).map((id) => id.trim()).filter(Boolean))
  return {
    async get(subscriberId: string): Promise<Entitlement> {
      if (options.allPremium === true || premium.has(subscriberId)) {
        return { subscriberId, tier: 'premium', expiresAtMs: null, source: 'static' }
      }
      return free(subscriberId, 'static')
    },
  }
}

/** Lookup of the wallet a subscriber has verifiably linked. */
export interface WalletLinkStore {
  /** The linked, signature-verified wallet for a subscriber, or `null`. */
  walletOf(subscriberId: string): Promise<Address | null>
}

/** Options for {@link createUsdgEntitlementProvider}. */
export interface UsdgEntitlementOptions {
  client: HoodClient
  /** The operator's receiving address. Payments to any other address are ignored. */
  receiver: Address
  /** Price of one subscription period, in whole USDG. */
  pricePerPeriodUsdg: number
  /** Length of a period in days. @defaultValue `30` */
  periodDays?: number
  /** Where verified wallet links come from. */
  links: WalletLinkStore
  /** First block to scan for payments. @defaultValue `0n` */
  fromBlock?: bigint
  /** Cache lifetime per subscriber, in ms. @defaultValue `300_000` (5 minutes) */
  ttlMs?: number
  /** Retry/bisect options for the payment scan. */
  logOptions?: FetchLogRangeOptions
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

const transferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const

/**
 * Accrue an expiry from a payment history. Each payment buys
 * `floor(amount / price)` periods, starting from whenever the current
 * entitlement would have lapsed, so renewing early extends rather than
 * overwrites.
 *
 * Exported because it is the part worth testing on its own: everything else in
 * the provider is a log query.
 */
export function accrueExpiry(
  payments: readonly { atMs: number; amountUsdg: number }[],
  pricePerPeriodUsdg: number,
  periodDays: number,
): number | null {
  if (pricePerPeriodUsdg <= 0) return null
  const periodMs = periodDays * 86_400_000
  const ordered = [...payments].sort((a, b) => a.atMs - b.atMs)
  let expiry: number | null = null
  for (const payment of ordered) {
    const periods = Math.floor(payment.amountUsdg / pricePerPeriodUsdg)
    if (periods < 1) continue
    const start: number = expiry !== null && expiry > payment.atMs ? expiry : payment.atMs
    expiry = start + periods * periodMs
  }
  return expiry
}

/**
 * On-chain USDG entitlements.
 *
 * @example
 * ```ts
 * const entitlements = createUsdgEntitlementProvider({
 *   client: hood,
 *   receiver: '0xYourReceivingAddress',
 *   pricePerPeriodUsdg: 25,
 *   links: store,           // the service's SQLite store implements WalletLinkStore
 * })
 * const entitlement = await entitlements.get('telegram:12345')
 * ```
 */
export function createUsdgEntitlementProvider(options: UsdgEntitlementOptions): EntitlementProvider {
  const ttlMs = options.ttlMs ?? 300_000
  const now = options.now ?? Date.now
  const periodDays = options.periodDays ?? 30
  const usdg =
    options.client.network === 'testnet'
      ? '0x7E955252E15c84f5768B83c41a71F9eba181802F'
      : '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
  const cache = new Map<string, { entitlement: Entitlement; at: number }>()

  async function resolve(subscriberId: string): Promise<Entitlement> {
    const wallet = await options.links.walletOf(subscriberId)
    if (!wallet) return free(subscriberId, 'usdg:no-linked-wallet')

    const head = await options.client.public.getBlockNumber()
    const logs = await fetchLogRange(
      (from, to) =>
        options.client.public.getLogs({
          address: usdg as Address,
          event: transferEvent,
          args: { from: wallet, to: getAddress(options.receiver) },
          fromBlock: from,
          toBlock: to,
        }),
      options.fromBlock ?? 0n,
      head,
      options.logOptions ?? {},
    )
    if (logs.length === 0) return free(subscriberId, 'usdg:no-payments')

    const payments: { atMs: number; amountUsdg: number }[] = []
    for (const log of logs) {
      const value = log.args.value as bigint | undefined
      if (value === undefined || value === 0n) continue
      const block = await options.client.public.getBlock({
        blockNumber: log.blockNumber,
        includeTransactions: false,
      })
      payments.push({
        atMs: Number(block.timestamp) * 1000,
        amountUsdg: Number(formatUnits(value, USDG_DECIMALS)),
      })
    }

    const expiresAtMs = accrueExpiry(payments, options.pricePerPeriodUsdg, periodDays)
    if (expiresAtMs === null || expiresAtMs <= now()) {
      return { subscriberId, tier: 'free', expiresAtMs, source: 'usdg:lapsed' }
    }
    return { subscriberId, tier: 'premium', expiresAtMs, source: 'usdg' }
  }

  return {
    async get(subscriberId: string): Promise<Entitlement> {
      const hit = cache.get(subscriberId)
      if (hit && now() - hit.at < ttlMs) return hit.entitlement
      try {
        const entitlement = await resolve(subscriberId)
        cache.set(subscriberId, { entitlement, at: now() })
        return entitlement
      } catch (error) {
        // An RPC failure must never silently downgrade a paying subscriber to
        // free with no explanation, and must never upgrade a free one. Serve
        // the last known answer if there is one, otherwise free with a source
        // that says exactly what happened.
        if (hit) return hit.entitlement
        const message = error instanceof Error ? error.message : String(error)
        return free(subscriberId, `usdg:unavailable (${message})`)
      }
    },
  }
}

/**
 * Chain several providers: the first one that returns premium wins. Lets an
 * operator grant comps by configuration while still selling on chain.
 */
export function chainEntitlementProviders(
  ...providers: readonly EntitlementProvider[]
): EntitlementProvider {
  return {
    async get(subscriberId: string): Promise<Entitlement> {
      let last: Entitlement = free(subscriberId, 'chain:empty')
      for (const provider of providers) {
        const entitlement = await provider.get(subscriberId)
        if (entitlement.tier === 'premium') return entitlement
        last = entitlement
      }
      return last
    },
  }
}

/** The message a subscriber signs to link a wallet. */
export function linkMessage(subscriberId: string, nonce: string): string {
  return `hood-alerts wallet link\nsubscriber: ${subscriberId}\nnonce: ${nonce}`
}

/**
 * Verify a wallet link signature (EIP-191 `personal_sign`).
 *
 * The subscriber signs {@link linkMessage} with the wallet that pays, and the
 * service checks the signature before storing the link. Without this step,
 * anyone could paste a paying subscriber's address and inherit their
 * entitlement.
 *
 * @returns the checksummed address on success, `null` on any failure (bad
 * signature shape, wrong signer, malformed address).
 *
 * @example
 * ```ts
 * const nonce = crypto.randomUUID()
 * // the user signs linkMessage('telegram:12345', nonce) in their wallet
 * const address = await verifyWalletLink('telegram:12345', nonce, wallet, signature)
 * if (address) await store.linkWallet('telegram:12345', address)
 * ```
 */
export async function verifyWalletLink(
  subscriberId: string,
  nonce: string,
  address: string,
  signature: string,
): Promise<Address | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  try {
    const valid = await verifyMessage({
      address: getAddress(address),
      message: linkMessage(subscriberId, nonce),
      signature: signature as `0x${string}`,
    })
    return valid ? getAddress(address) : null
  } catch {
    return null
  }
}
