import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { openSeaHeaders, isAuthError } from './openseaAuth';

/** Thrown when OpenSea rejects the API key (401/403). Surfaced to the user as
 *  an actionable error instead of silently falling back to on-chain public-only
 *  detection (which misreports WL/presale drops as "Mint has not started yet"). */
export class OpenSeaAuthError extends Error {
  status: number;
  constructor(status: number) {
    super(`OpenSea API key rejected (HTTP ${status}). Set a valid key with /api set <key>.`);
    this.name = 'OpenSeaAuthError';
    this.status = status;
  }
}

export interface DropStage {
  uuid: string;
  stage_type: 'public_sale' | 'signed_presale' | 'allowlist_presale';
  label: string;
  price: string;
  price_currency_address: string;
  start_time: string;
  end_time: string;
  max_per_wallet: string;
}

export interface DropInfo {
  collection_slug: string;
  collection_name: string;
  chain: string;
  contract_address: string;
  drop_type: string;
  is_minting: boolean;
  image_url: string;
  opensea_url: string;
  active_stage: DropStage | null;
  next_stage: DropStage | null;
  stages: DropStage[];
  total_supply?: string;
  max_supply?: string;
}

export async function checkIfDrop(slug: string): Promise<DropInfo | null> {
  try {
    const url = `${config.opensea.baseUrl}/api/v2/drops/${slug}`;
    logger.info(`[DROP] Checking if ${slug} is a Drop collection`);

    const response = await axios.get<DropInfo>(url, {
      headers: openSeaHeaders(),
      timeout: 5000,
    });

    logger.info(`[DROP] ${slug} is a Drop collection (${response.data.drop_type})`);
    return response.data;
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 0;
      if (status === 404) {
        logger.info(`[DROP] ${slug} is not a Drop collection (404)`);
        return null;
      }
      if (isAuthError(status)) {
        // Do NOT swallow: a dead key must not masquerade as "not a drop".
        logger.error(`[DROP] OpenSea API key rejected (${status}) checking ${slug}`);
        throw new OpenSeaAuthError(status);
      }
      logger.warn(`[DROP] Error checking Drop status: ${status || err.message}`);
    }
    return null;
  }
}

/**
 * Find the public_sale stage of a drop, if any. (Kept for compatibility.)
 */
export function getPublicStage(drop: DropInfo): DropStage | null {
  return drop.stages?.find((s) => s.stage_type === 'public_sale') ?? null;
}

/**
 * Milliseconds until a stage window opens. Negative if already open/past.
 * Returns null if the stage or its start_time is missing/unparseable.
 */
export function msUntilStageOpens(stage: DropStage | null): number | null {
  if (!stage?.start_time) return null;
  const start = Date.parse(stage.start_time);
  if (Number.isNaN(start)) return null;
  return start - Date.now();
}

/**
 * True if the given stage is currently within its [start, end) window.
 */
export function isStageOpen(stage: DropStage | null): boolean {
  if (!stage?.start_time) return false;
  const now = Date.now();
  const start = Date.parse(stage.start_time);
  const end = stage.end_time ? Date.parse(stage.end_time) : NaN;
  if (Number.isNaN(start)) return false;
  if (now < start) return false;
  if (!Number.isNaN(end) && now >= end) return false;
  return true;
}

/**
 * True if ANY stage (WL, presale, or public) is currently open.
 * OpenSea's /mint endpoint auto-selects the active stage the wallet is
 * eligible for, so the bot only needs to know *some* stage is live — it must
 * NOT force a specific stage type.
 */
export function anyStageOpen(drop: DropInfo): boolean {
  return (drop.stages ?? []).some((s) => isStageOpen(s));
}

/**
 * The soonest-opening stage of ANY type that has not opened yet.
 * Used by the (stage-agnostic) window guard to wait for whatever stage opens
 * next — WL/presale/public alike — without preferring one over another.
 * Returns null when no future stage exists.
 */
export function getNextOpeningStage(drop: DropInfo): DropStage | null {
  const now = Date.now();
  const upcoming = (drop.stages ?? [])
    .filter((s) => {
      if (!s.start_time) return false;
      const start = Date.parse(s.start_time);
      return !Number.isNaN(start) && start > now;
    })
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  return upcoming[0] ?? null;
}
