import type { Address } from 'viem';
import { publicClient } from '../rpc/client';
import SeaDropV1Abi from '../../abis/SeaDropV1.json';
import { SEADROP_V1_ADDRESS } from '../mint/seadropDetector';
import type { PublicDrop } from '../mint/seadropDetector';
import { logger } from '../utils/logger';

/**
 * On-chain SeaDrop state for a drop + wallet, read through the bot's own
 * latency-ranked public client (same RPC order the mint engine uses).
 *
 * This complements the OpenSea/SIWE check: it answers what the chain says —
 * public stage open or not, how much this wallet already minted, remaining
 * supply, and whether an allowlist Merkle root is set (i.e. a gated stage
 * exists on-chain). It never sends a transaction.
 */

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const NFT_MINT_STATS_ABI = [
  {
    name: 'getMintStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [
      { name: 'minterNumMinted', type: 'uint256' },
      { name: 'currentTotalSupply', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
    ],
  },
] as const;

// Not part of the trimmed bundled ABI — the canonical SeaDrop function for
// the allowlist Merkle root, declared inline (same pattern as mintConfigReader).
const ALLOWLIST_ROOT_ABI = [
  {
    name: 'getAllowListMerkleRoot',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

export interface SeaDropState {
  mintedByWallet: bigint;
  currentSupply: bigint;
  maxSupply: bigint;
  soldOut: boolean;
  publicDrop: PublicDrop | null;
  publicOpen: boolean;
  hasAllowlistRoot: boolean;
}

function normalizePublicDrop(raw: unknown): PublicDrop | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const arr = Array.isArray(raw) ? (raw as unknown[]) : null;
  const pick = (name: string, idx: number): unknown =>
    rec[name] !== undefined ? rec[name] : arr?.[idx];
  try {
    return {
      mintPrice: BigInt(String(pick('mintPrice', 0) ?? 0)),
      startTime: BigInt(String(pick('startTime', 1) ?? 0)),
      endTime: BigInt(String(pick('endTime', 2) ?? 0)),
      maxTotalMintableByWallet: Number(pick('maxTotalMintableByWallet', 3) ?? 0),
      feeBps: Number(pick('feeBps', 4) ?? 0),
      restrictFeeRecipients: Boolean(pick('restrictFeeRecipients', 5) ?? false),
    };
  } catch {
    return null;
  }
}

export async function readSeaDropState(
  nftContract: Address,
  wallet: Address
): Promise<SeaDropState> {
  // Mint stats: SeaDrop (2-param) first, NFT contract (1-param) fallback —
  // mirrors mintConfigReader so both paths report identical numbers.
  let minted = 0n;
  let supply = 0n;
  let maxSupply = 0n;
  let statsOk = false;
  try {
    const result = (await publicClient.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: SeaDropV1Abi,
      functionName: 'getMintStats',
      args: [nftContract, wallet],
    })) as [bigint, bigint, bigint];
    minted = result[0] ?? 0n;
    supply = result[1] ?? 0n;
    maxSupply = result[2] ?? 0n;
    statsOk = true;
  } catch {
    try {
      const result = await publicClient.readContract({
        address: nftContract,
        abi: NFT_MINT_STATS_ABI,
        functionName: 'getMintStats',
        args: [wallet],
      });
      minted = result[0];
      supply = result[1];
      maxSupply = result[2];
      statsOk = true;
    } catch (err) {
      logger.warn(
        `[WL] getMintStats failed for ${nftContract}: ${
          err instanceof Error ? err.message : 'unknown'
        }`
      );
    }
  }

  let publicDrop: PublicDrop | null = null;
  try {
    const raw = await publicClient.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: SeaDropV1Abi,
      functionName: 'getPublicDrop',
      args: [nftContract],
    });
    publicDrop = normalizePublicDrop(raw);
  } catch {
    publicDrop = null;
  }

  let hasAllowlistRoot = false;
  try {
    const root = await publicClient.readContract({
      address: SEADROP_V1_ADDRESS,
      abi: ALLOWLIST_ROOT_ABI,
      functionName: 'getAllowListMerkleRoot',
      args: [nftContract],
    });
    hasAllowlistRoot = root !== ZERO_BYTES32;
  } catch {
    hasAllowlistRoot = false;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const publicOpen =
    publicDrop !== null &&
    publicDrop.startTime <= now &&
    (publicDrop.endTime === 0n || publicDrop.endTime > now);

  return {
    mintedByWallet: minted,
    currentSupply: supply,
    maxSupply,
    soldOut: statsOk && maxSupply > 0n && supply >= maxSupply,
    publicDrop,
    publicOpen,
    hasAllowlistRoot,
  };
}
