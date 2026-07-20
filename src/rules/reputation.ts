import { formatUnits, getAddress, type Address } from 'viem'
import {
  MAINNET_ADDRESSES,
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  USDG_DECIMALS,
  erc20Abi,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  type HoodClient,
} from 'hoodchain'
import { fetchLogRange, type FetchLogRangeOptions } from '../events/logs.js'
import { quoteTokens, type PriceOracle } from '../events/pricing.js'
import type { Launchpad } from '../events/types.js'

/**
 * Deployer reputation, derived entirely from chain state.
 *
 * Nothing here is scraped, self-reported or scored by a model. Three
 * measurements, each with an exact on-chain definition:
 *
 * - **Prior launches**: `TokenLaunched` logs on the NOXA factory with
 *   `deployer` indexed to this address, plus `TokenCreated` logs on the three
 *   Odyssey factories with `creator` indexed to this address. Both queries are
 *   topic-selective, so the RPC serves them across the full chain history in
 *   one call each.
 * - **LP locked**: for a NOXA launch, the LP position NFT is locked when
 *   `NonfungiblePositionManager.ownerOf(positionId)` is the NOXA locker
 *   contract. That is the launchpad's own permanent-lock mechanism, read
 *   directly rather than trusted from a UI badge.
 * - **Rugged**: a prior launch whose pool quote-token reserve has since fallen
 *   below `rugThresholdUsd`. Liquidity that was seeded and is now gone is the
 *   observable footprint of a pull. It is a heuristic and is labelled as one
 *   everywhere it surfaces: a token that simply never traded and a token whose
 *   liquidity was withdrawn both end up with an empty pool, and only the
 *   second is a rug. Pair it with `minPriorLaunches` for a meaningful signal.
 *
 * Results are cached per deployer, because a launch burst from one deployer
 * would otherwise re-run the same history scan per event.
 */

/** One prior launch by a deployer. */
export interface PriorLaunch {
  launchpad: Launchpad
  token: Address
  pool: Address | null
  quoteToken: Address | null
  /** NOXA LP position id, when the launch had one. */
  positionId: bigint | null
  blockNumber: bigint
}

/** A deployer's on-chain track record. */
export interface DeployerReputation {
  deployer: Address
  /** Every launch found, oldest first. Capped by `maxHistory`. */
  launches: PriorLaunch[]
  /** Launches whose LP position is held by the NOXA locker. */
  lockedLaunches: number
  /** Launches whose pool reserve is now below the rug threshold. */
  ruggedLaunches: number
  /**
   * How many launches were actually inspected for lock/rug status. Lower than
   * `launches.length` when the history exceeds `maxInspect`, and surfaced so
   * consumers never read a partial scan as a clean record.
   */
  inspected: number
  /** When this record was computed, ms since epoch. */
  computedAtMs: number
}

/** Reputation lookups for the rule engine. */
export interface ReputationProvider {
  get(deployer: Address): Promise<DeployerReputation>
  /** Is a specific LP position locked by the launchpad locker? */
  isLpLocked(positionId: bigint): Promise<boolean>
}

/** Options for {@link createRpcReputationProvider}. */
export interface ReputationProviderOptions {
  /** Cache lifetime per deployer, in ms. @defaultValue `600_000` (10 minutes) */
  ttlMs?: number
  /** Max launches kept per deployer. @defaultValue `200` */
  maxHistory?: number
  /**
   * Max prior launches inspected for lock/rug status per deployer. Each one
   * costs a pool balance read, so this bounds the RPC cost of a rule.
   * @defaultValue `25`
   */
  maxInspect?: number
  /** Pool reserve below this USD value counts as drained. @defaultValue `50` */
  rugThresholdUsd?: number
  /** Retry/bisect options for the history queries. */
  logOptions?: FetchLogRangeOptions
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

const positionManagerAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

/**
 * Build an RPC-backed reputation provider.
 *
 * @example
 * ```ts
 * const reputation = createRpcReputationProvider(hood, oracle)
 * const record = await reputation.get('0xDeployer…')
 * console.log(record.launches.length, 'prior launches,', record.ruggedLaunches, 'drained')
 * ```
 */
export function createRpcReputationProvider(
  client: HoodClient,
  oracle: PriceOracle,
  options: ReputationProviderOptions = {},
): ReputationProvider {
  const ttlMs = options.ttlMs ?? 600_000
  const maxHistory = options.maxHistory ?? 200
  const maxInspect = options.maxInspect ?? 25
  const rugThresholdUsd = options.rugThresholdUsd ?? 50
  const now = options.now ?? Date.now
  const cache = new Map<string, DeployerReputation>()
  const inflight = new Map<string, Promise<DeployerReputation>>()
  const lockCache = new Map<string, boolean>()
  const { weth, usdg } = quoteTokens(client)

  async function reserveUsd(pool: Address, quoteToken: Address): Promise<number | null> {
    const quote = quoteToken.toLowerCase()
    if (quote !== weth.toLowerCase() && quote !== usdg.toLowerCase()) return null
    const balance = await client.public.readContract({
      address: quoteToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool],
    })
    if (quote === usdg.toLowerCase()) return Number(formatUnits(balance, USDG_DECIMALS))
    return oracle.weiToUsd(balance)
  }

  async function isLpLocked(positionId: bigint): Promise<boolean> {
    const key = positionId.toString()
    const hit = lockCache.get(key)
    if (hit !== undefined) return hit
    try {
      const owner = await client.public.readContract({
        address: MAINNET_ADDRESSES.nonfungiblePositionManager,
        abi: positionManagerAbi,
        functionName: 'ownerOf',
        args: [positionId],
      })
      const locked = owner.toLowerCase() === NOXA_ADDRESSES.locker.toLowerCase()
      lockCache.set(key, locked)
      return locked
    } catch {
      // A burned or non-existent position reverts. Unknown is not locked.
      return false
    }
  }

  async function load(deployer: Address): Promise<DeployerReputation> {
    const head = await client.public.getBlockNumber()
    const [noxaLogs, odysseyLogs] = await Promise.all([
      fetchLogRange(
        (from, to) =>
          client.public.getLogs({
            address: NOXA_ADDRESSES.launchFactory,
            event: noxaTokenLaunchedEvent,
            args: { deployer },
            fromBlock: from,
            toBlock: to,
          }),
        NOXA_ADDRESSES.deployBlock,
        head,
        options.logOptions ?? {},
      ),
      fetchLogRange(
        (from, to) =>
          client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyTokenCreatedEvent,
            args: { creator: deployer },
            fromBlock: from,
            toBlock: to,
          }),
        NOXA_ADDRESSES.deployBlock,
        head,
        options.logOptions ?? {},
      ),
    ])

    const launches: PriorLaunch[] = []
    for (const log of noxaLogs) {
      const token = log.args.token as Address | undefined
      if (!token) continue
      const pool = (log.args.pool as Address | undefined) ?? null
      const pairToken = (log.args.pairToken as Address | undefined) ?? null
      launches.push({
        launchpad: 'noxa',
        token: getAddress(token),
        pool: pool ? getAddress(pool) : null,
        quoteToken: pairToken ? getAddress(pairToken) : null,
        positionId: (log.args.positionId as bigint | undefined) ?? null,
        blockNumber: log.blockNumber,
      })
    }
    for (const log of odysseyLogs) {
      const token = log.args.token as Address | undefined
      if (!token) continue
      launches.push({
        launchpad: 'odyssey',
        token: getAddress(token),
        pool: null,
        quoteToken: null,
        positionId: null,
        blockNumber: log.blockNumber,
      })
    }
    launches.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0))
    const kept = launches.slice(-maxHistory)

    // Inspect the most recent launches for lock and drain status.
    const inspectable = kept.slice(-maxInspect)
    let lockedLaunches = 0
    let ruggedLaunches = 0
    for (const launch of inspectable) {
      if (launch.positionId !== null && (await isLpLocked(launch.positionId))) lockedLaunches += 1
      if (launch.pool && launch.quoteToken) {
        try {
          const usd = await reserveUsd(launch.pool, launch.quoteToken)
          if (usd !== null && usd < rugThresholdUsd) ruggedLaunches += 1
        } catch {
          // An unreadable pool is not evidence of a rug. Skip it.
        }
      }
    }

    return {
      deployer: getAddress(deployer),
      launches: kept,
      lockedLaunches,
      ruggedLaunches,
      inspected: inspectable.length,
      computedAtMs: now(),
    }
  }

  return {
    async get(deployer: Address): Promise<DeployerReputation> {
      const key = deployer.toLowerCase()
      const hit = cache.get(key)
      if (hit && now() - hit.computedAtMs < ttlMs) return hit
      const pending = inflight.get(key)
      if (pending) return pending
      const promise = load(deployer)
        .then((record) => {
          cache.set(key, record)
          return record
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, promise)
      return promise
    },
    isLpLocked,
  }
}

/**
 * Count a deployer's launches that happened strictly before a block. Rules ask
 * "how many had they launched *at the time of this event*", which is not the
 * same as "how many have they launched now", and only the first is stable when
 * a historical range is re-processed after a restart.
 */
export function priorLaunchesBefore(record: DeployerReputation, blockNumber: bigint): number {
  return record.launches.filter((launch) => launch.blockNumber < blockNumber).length
}
