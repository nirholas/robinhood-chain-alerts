/**
 * Read a deployer's on-chain track record: how many tokens they have launched
 * on NOXA and The Odyssey, how many of those LP positions are locked by the
 * launchpad locker, and how many of their pools have since been drained.
 *
 *   npx tsx examples/deployer-reputation.ts 0xDeployerAddress
 *
 * Everything printed is derived from logs and contract reads. Nothing is
 * scraped or scored by a model. The "drained" figure is a heuristic (a pool
 * whose quote reserve is now below the rug threshold) and is labelled as one.
 */
import { getAddress, type Address } from 'viem'
import { createHoodClient } from 'hoodchain'
import { createPriceOracle } from '../src/events/index.js'
import { createRpcReputationProvider } from '../src/rules/index.js'

async function main(): Promise<void> {
  const input = process.argv[2]
  if (!input || !/^0x[0-9a-fA-F]{40}$/.test(input)) {
    console.error('usage: npx tsx examples/deployer-reputation.ts <0x deployer address>')
    process.exit(1)
  }
  const deployer = getAddress(input as Address)

  const hood = createHoodClient({
    ...(process.env['ROBINHOOD_RPC_URL'] ? { rpcUrl: process.env['ROBINHOOD_RPC_URL'] } : {}),
  })
  const reputation = createRpcReputationProvider(hood, createPriceOracle(hood), {
    rugThresholdUsd: Number(process.env['RUG_THRESHOLD_USD'] ?? '50'),
  })

  const started = Date.now()
  const record = await reputation.get(deployer)

  console.log(`deployer ${record.deployer}`)
  console.log(`  launches:        ${record.launches.length}`)
  console.log(`  inspected:       ${record.inspected} most recent`)
  console.log(`  LP locked:       ${record.lockedLaunches}`)
  console.log(`  drained pools:   ${record.ruggedLaunches} (heuristic: quote reserve below the threshold)`)
  console.log(`  scan took:       ${Date.now() - started}ms`)

  for (const launch of record.launches.slice(-10)) {
    console.log(
      `    ${launch.launchpad.padEnd(8)} ${launch.token} block ${launch.blockNumber}` +
        (launch.pool ? ` pool ${launch.pool}` : ' (on curve)'),
    )
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
