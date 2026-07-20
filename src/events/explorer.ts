import type { Address, Hash } from 'viem'

/** Blockscout explorer base URL for Robinhood Chain mainnet (chain 4663). */
export const MAINNET_EXPLORER = 'https://robinhoodchain.blockscout.com'

/** Explorer base URL for Robinhood Chain testnet (chain 46630). */
export const TESTNET_EXPLORER = 'https://explorer.testnet.chain.robinhood.com'

/** Resolve the explorer base URL for a network name. */
export function explorerBase(network: 'mainnet' | 'testnet'): string {
  return network === 'testnet' ? TESTNET_EXPLORER : MAINNET_EXPLORER
}

/** Link to a transaction. */
export function txUrl(base: string, hash: Hash): string {
  return `${base}/tx/${hash}`
}

/** Link to an address (wallet or contract). */
export function addressUrl(base: string, address: Address): string {
  return `${base}/address/${address}`
}

/** Link to a token page (Blockscout renders holders/transfers there). */
export function tokenUrl(base: string, token: Address): string {
  return `${base}/token/${token}`
}

/** Link to a block. */
export function blockUrl(base: string, blockNumber: bigint): string {
  return `${base}/block/${blockNumber}`
}
