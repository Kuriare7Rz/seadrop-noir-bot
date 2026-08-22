import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { getAppSetting, setAppSetting, getAppSettingMeta } from '../db/appSettings';
import { logger } from '../utils/logger';

export const OPENSEA_KEY_SETTING = 'opensea_api_key';

/**
 * Effective OpenSea API key: a runtime override set via /api (DB) takes
 * precedence over the .env value. This lets us hot-swap an expired/revoked
 * key without a redeploy — the previous failure mode where a dead key made
 * the whole Drops API return 401 and the bot silently fell back to on-chain
 * public-only detection ("Mint has not started yet").
 */
export function getOpenSeaApiKey(): string {
  const override = getAppSetting(OPENSEA_KEY_SETTING);
  if (override && override.trim().length > 0) return override.trim();
  return config.opensea.apiKey;
}

/** Standard headers for OpenSea API calls using the effective key. */
export function openSeaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-api-key': getOpenSeaApiKey(),
    Accept: 'application/json',
    ...extra,
  };
}

export function persistOpenSeaApiKey(key: string, updatedBy?: string): void {
  setAppSetting(OPENSEA_KEY_SETTING, key.trim(), updatedBy);
  logger.info(`[OPENSEA] API key updated via runtime override by ${updatedBy ?? 'unknown'}`);
}

export function getOpenSeaKeyMeta(): {
  source: 'override' | 'env';
  masked: string;
  updated_by: string | null;
  updated_at: string | null;
} {
  const meta = getAppSettingMeta(OPENSEA_KEY_SETTING);
  const override = meta?.value?.trim();
  const key = override && override.length > 0 ? override : config.opensea.apiKey;
  const masked =
    key.length <= 8 ? `${key.slice(0, 2)}***` : `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`;
  return {
    source: override && override.length > 0 ? 'override' : 'env',
    masked,
    updated_by: meta?.updated_by ?? null,
    updated_at: meta?.updated_at ?? null,
  };
}

export interface OpenSeaKeyCheck {
  ok: boolean;
  status: number;
  detail: string;
}

/**
 * Live-verify a key against the OpenSea Drops API (the exact endpoint the mint
 * flow depends on). A key can pass the public /collections check but still be
 * rejected on /drops, so we probe the authenticated path. Uses a known public
 * drop slug when none is provided.
 */
export async function verifyOpenSeaKey(key?: string, probeSlug = 'ntrpygenesis'): Promise<OpenSeaKeyCheck> {
  const effective = (key && key.trim()) || getOpenSeaApiKey();
  const url = `${config.opensea.baseUrl}/api/v2/drops/${probeSlug}`;
  try {
    const res = await axios.get(url, {
      headers: { 'x-api-key': effective, Accept: 'application/json' },
      timeout: 6000,
      validateStatus: () => true,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, detail: 'Invalid or unauthorized API key' };
    }
    // 200 = drop found, 404 = key OK but slug isn't a drop — both mean auth works.
    if (res.status === 200 || res.status === 404) {
      return { ok: true, status: res.status, detail: res.status === 200 ? 'Key valid (drop reachable)' : 'Key valid (auth OK)' };
    }
    if (res.status === 429) {
      return { ok: true, status: 429, detail: 'Rate limited, but auth accepted' };
    }
    return { ok: false, status: res.status, detail: `Unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof AxiosError ? err.message : err instanceof Error ? err.message : 'unknown';
    return { ok: false, status: 0, detail: `Network error: ${msg}` };
  }
}

/** True when an OpenSea error status indicates an auth/key problem. */
export function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}
