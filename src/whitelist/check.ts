import axios from 'axios';
import { getAddress, type Address } from 'viem';
import { config } from '../config';
import { openSeaHeaders } from '../mint/openseaAuth';
import { parseOpenSeaUrl } from '../mint/urlParser';
import { walletPool } from '../wallet/pool';
import { logger } from '../utils/logger';
import { checkOpenSeaEligibility, type OpenSeaEligibility } from './siwe';
import { readSeaDropState, type SeaDropState } from './seadrop';
import type { WalletRange } from '../mint/engine';

/**
 * /wl orchestrator: one drop in, a per-wallet eligibility matrix out.
 *
 * Input is an OpenSea collection URL, a bare collection slug, an /assets/
 * URL, or a bare NFT contract address. Everything resolves to a
 * (slug, contract) pair where possible:
 *  - slug -> contract via the OpenSea v2 collections endpoint (bot's API key)
 *  - contract -> slug via the OpenSea v2 chain/contract endpoint
 *
 * Each registered pool wallet then gets both checks that exist for it:
 * the authoritative OpenSea/SIWE eligibility (gated stages) and the
 * on-chain SeaDrop state (public stage, caps, supply, allowlist root).
 */

export interface WalletWlResult {
  index: number;
  address: Address;
  opensea: OpenSeaEligibility | null;
  openseaSkipped?: string;
  seadrop: SeaDropState | null;
  seadropError?: string;
}

export interface WlReport {
  input: string;
  slug: string | null;
  contract: Address | null;
  chainLabel: string;
  range: WalletRange | null;
  results: WalletWlResult[];
}

async function resolveContractFromSlug(slug: string): Promise<Address | null> {
  try {
    const res = await axios.get(
      `${config.opensea.baseUrl}/api/v2/collections/${encodeURIComponent(slug)}`,
      { headers: openSeaHeaders(), timeout: 15_000, validateStatus: () => true }
    );
    if (res.status !== 200) return null;
    const data = res.data as Record<string, unknown>;
    const contracts = data.contracts as
      | { address?: string; chain?: string }[]
      | undefined;
    if (Array.isArray(contracts)) {
      const mine = contracts.find(
        (c) => c.chain === config.chain.openSeaSlug && c.address
      );
      const chosen = mine ?? contracts.find((c) => c.address);
      if (chosen?.address) return getAddress(chosen.address);
    }
    const legacy = data.primary_asset_contracts as
      | { address?: string }[]
      | undefined;
    if (Array.isArray(legacy) && legacy[0]?.address) {
      return getAddress(legacy[0].address);
    }
    return null;
  } catch (err) {
    logger.warn(
      `[WL] slug->contract resolution failed for ${slug}: ${
        err instanceof Error ? err.message : 'unknown'
      }`
    );
    return null;
  }
}

async function resolveSlugFromContract(contract: Address): Promise<string | null> {
  try {
    const res = await axios.get(
      `${config.opensea.baseUrl}/api/v2/chain/${config.chain.openSeaSlug}/contract/${contract}`,
      { headers: openSeaHeaders(), timeout: 15_000, validateStatus: () => true }
    );
    if (res.status !== 200) return null;
    const data = res.data as Record<string, unknown>;
    const slug =
      (typeof data.collection === 'string' && data.collection) ||
      (typeof data.collection_slug === 'string' && data.collection_slug) ||
      null;
    return slug;
  } catch {
    return null;
  }
}

export function parseWlInput(raw: string): { slug: string | null; contract: Address | null } {
  const trimmed = raw.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    return { slug: null, contract: getAddress(trimmed) };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseOpenSeaUrl(trimmed);
    return {
      slug: parsed.slug ?? null,
      contract: parsed.contractAddress ?? null,
    };
  }
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { slug: trimmed, contract: null };
  }
  throw new Error(
    'Unrecognized input. Use an OpenSea collection URL, a collection slug, or a contract address.'
  );
}

export async function checkWhitelist(
  rawInput: string,
  range?: WalletRange
): Promise<WlReport> {
  let { slug, contract } = parseWlInput(rawInput);
  if (slug && !contract) contract = await resolveContractFromSlug(slug);
  if (contract && !slug) slug = await resolveSlugFromContract(contract);

  const all = walletPool.getPoolStatus();
  if (all.length === 0) {
    throw new Error('No wallets configured in the pool.');
  }

  // Optional [from] [to] wallet range — same 1-based, inclusive, clamped
  // semantics as /mint_max and /schedule_mint. Wallet numbers in the report
  // stay global (matching /wallets), not relative to the slice.
  const startIdx = range ? range.from - 1 : 0;
  const endIdx = range ? Math.min(range.to, all.length) : all.length;
  const pool = all.slice(startIdx, endIdx);

  const results: WalletWlResult[] = [];
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i]!;
    const address = entry.address as Address;
    const result: WalletWlResult = {
      index: startIdx + i + 1,
      address,
      opensea: null,
      seadrop: null,
    };

    if (slug) {
      const pk = walletPool.getPrivateKey(address);
      if (!pk) {
        result.openseaSkipped = 'no private key in pool for this wallet';
      } else {
        result.opensea = await checkOpenSeaEligibility(address, pk, slug);
      }
    } else {
      result.openseaSkipped = 'could not resolve a collection slug for this contract';
    }

    if (contract) {
      try {
        result.seadrop = await readSeaDropState(contract, address);
      } catch (err) {
        result.seadropError =
          err instanceof Error ? err.message : 'on-chain read failed';
      }
    }

    results.push(result);
    logger.info(
      `[WL] ${address} opensea=${result.opensea?.status ?? 'skipped'} ` +
        `seadrop=${result.seadrop ? 'ok' : (result.seadropError ?? 'n/a')}`
    );
  }

  return {
    input: rawInput,
    slug,
    contract,
    chainLabel: config.chain.label,
    range: range ?? null,
    results,
  };
}
