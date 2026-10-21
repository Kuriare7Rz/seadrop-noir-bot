import { defineChain } from 'viem';
import { mainnet } from 'viem/chains';
import type { Chain } from 'viem';

/**
 * Multi-chain registry for the SeaDrop minter.
 *
 * SeaDrop V1 (0x00005EA00Ac477B1030CE78506496e8C2dE24bf5) is deployed at the same
 * CREATE2 address on every supported chain, so the on-chain mint path works
 * identically once the RPC + chain metadata point at the right network.
 *
 * The active chain is chosen with the MINT_CHAIN env var (default: ethereum).
 */

export type ChainKey = 'ethereum' | 'robinhood';

export interface ChainProfile {
  key: ChainKey;
  /** viem Chain object used by public + wallet clients */
  chain: Chain;
  /** numeric chain id */
  chainId: number;
  /** human label for messages */
  label: string;
  /** native currency symbol (for message formatting) */
  symbol: string;
  /** block explorer base, no trailing slash — used to build tx links */
  explorerTxBase: string;
  /** explorer display name for link text */
  explorerName: string;
  /** OpenSea chain slug used in API paths + /assets/{slug}/ URLs */
  openSeaSlug: string;
  /** Etherscan V2 chainid for risk checks; null when no Etherscan-family explorer API exists */
  etherscanChainId: number | null;
  /** Chain-aware snipe defaults (used when the matching SNIPE_* env var is unset) */
  snipe: SnipeProfile;
}

/**
 * Per-chain snipe tuning. Different chains win FCFS differently:
 *  - Ethereum mainnet: priority-fee auction + first-block inclusion (~12s blocks).
 *    Winning = aggressive priority fee. Hammer interval can be relaxed.
 *  - Robinhood Chain: sequencer with ~0.1s blocks and NO priority-fee market
 *    (eth_maxPriorityFeePerGas returns 0). Winning = pure latency, NOT gas.
 *    Priority fee is wasted spend; hammer as fast as rate limits allow.
 */
export interface SnipeProfile {
  /** priority fee (gwei) for snipe fast-path */
  priorityFeeGwei: number;
  /** maxFeePerGas headroom = baseFee * this multiplier + priority fee */
  baseFeeMultiplier: number;
  /** interval (ms) between /mint hammer attempts */
  hammerIntervalMs: number;
  /** start hammering this many ms before the window opens */
  leadMs: number;
  /** fixed gas limit units (skip estimateGas RPC) */
  gasLimit: bigint;
}

// Robinhood Chain — chainId 4663 (0x1237). Custom viem chain.
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const CHAIN_PROFILES: Record<ChainKey, ChainProfile> = {
  ethereum: {
    key: 'ethereum',
    chain: mainnet,
    chainId: 1,
    label: 'Ethereum',
    symbol: 'ETH',
    explorerTxBase: 'https://etherscan.io/tx',
    explorerName: 'Etherscan',
    openSeaSlug: 'ethereum',
    etherscanChainId: 1,
    // ETH mainnet: gas auction matters. Aggressive priority, relaxed hammer.
    snipe: {
      priorityFeeGwei: 2,
      baseFeeMultiplier: 3,
      hammerIntervalMs: 150,
      leadMs: 800,
      gasLimit: 250000n,
    },
  },
  robinhood: {
    key: 'robinhood',
    chain: robinhoodChain,
    chainId: 4663,
    label: 'Robinhood Chain',
    symbol: 'ETH',
    explorerTxBase: 'https://robinhoodchain.blockscout.com/tx',
    explorerName: 'Robinhood Explorer',
    openSeaSlug: 'robinhood',
    etherscanChainId: null,
    // Robinhood: ~0.1s blocks, no priority market (maxPriorityFee=0), baseFee ~0.05 gwei.
    // Winning is pure latency. Priority fee = 0 (no waste), tiny bump only for min.
    // Hammer as fast as sane (50ms) since blocks are sub-second; lead a bit earlier.
    snipe: {
      priorityFeeGwei: 0,
      baseFeeMultiplier: 4,
      hammerIntervalMs: 50,
      leadMs: 1200,
      gasLimit: 300000n,
    },
  },
};

export function isChainKey(x: string): x is ChainKey {
  return x === 'ethereum' || x === 'robinhood';
}

export function getChainProfile(key: ChainKey): ChainProfile {
  return CHAIN_PROFILES[key];
}
