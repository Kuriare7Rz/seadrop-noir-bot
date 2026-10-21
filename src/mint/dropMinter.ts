import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getProxyAgentForWallet, getProxyUrlForWallet } from '../rpc/proxyPool';
import { openSeaHeaders, openSeaAgentOpts } from './openseaAuth';
import type { Address } from 'viem';

export interface DropMintTransactionData {
  to: Address;
  data: `0x${string}`;
  value: string;
}

export interface DropMintError {
  code: 'NOT_ELIGIBLE' | 'DROP_INACTIVE' | 'NOT_FOUND' | 'SERVER_ERROR' | 'RATE_LIMITED' | 'AUTH_ERROR' | 'UNKNOWN';
  message: string;
  status: number;
  // On 429: server-suggested wait (ms) parsed from Retry-After, when present.
  retryAfterMs?: number;
}

export async function buildDropMintTransaction(
  slug: string,
  minter: Address,
  quantity: number,
  walletIndex: number | null = null
): Promise<{ success: true; data: DropMintTransactionData } | { success: false; error: DropMintError }> {
  try {
    const url = `${config.opensea.baseUrl}/api/v2/drops/${slug}/mint`;

    // Rotate this wallet's OpenSea request through its assigned proxy (if any)
    // so many wallets appear as many IPs, dodging per-IP 429 rate limits.
    const proxyAgent = getProxyAgentForWallet(walletIndex);
    if (proxyAgent) {
      const proxyUrl = getProxyUrlForWallet(walletIndex);
      logger.info(`[DROP_MINT] ${slug} (minter: ${minter}, qty: ${quantity}) via proxy ${proxyUrl?.replace(/\/\/.*@/, '//***@')}`);
    } else {
      logger.info(`[DROP_MINT] Requesting mint transaction for ${slug} (minter: ${minter}, qty: ${quantity})`);
    }

    const response = await axios.post<DropMintTransactionData>(
      url,
      {
        minter,
        quantity,
      },
      {
        headers: openSeaHeaders({
          'Content-Type': 'application/json',
        }),
        timeout: 10000,
        // Proxied: use the wallet's proxy agent (own pool). Direct: reuse a
        // warm keep-alive connection so the hammer loop skips TLS handshakes.
        ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false as const } : openSeaAgentOpts()),
      }
    );

    logger.info(`[DROP_MINT] Successfully received mint transaction data`);
    return { success: true, data: response.data };
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 0;
      const responseData = err.response?.data;

      let errorCode: DropMintError['code'] = 'UNKNOWN';
      let message = 'Unknown error';

      if (status === 422) {
        errorCode = 'NOT_ELIGIBLE';
        message = 'Wallet not eligible for this drop (not in whitelist or limit reached)';
      } else if (status === 401 || status === 403) {
        errorCode = 'AUTH_ERROR';
        message = `OpenSea API key rejected (${status}). Set a valid key with /api set <key>.`;
        logger.error(`[DROP_MINT] ${message}`);
        return { success: false, error: { code: errorCode, message, status } };
      } else if (status === 409) {
        errorCode = 'DROP_INACTIVE';
        message = 'Drop is not currently active for minting';
      } else if (status === 404) {
        errorCode = 'NOT_FOUND';
        message = 'Drop not found';
      } else if (status === 429) {
        errorCode = 'RATE_LIMITED';
        const retryAfter = err.response?.headers?.['retry-after'];
        let retryAfterMs: number | undefined;
        if (retryAfter !== undefined) {
          const secs = Number(retryAfter);
          if (!Number.isNaN(secs)) retryAfterMs = secs * 1000;
          else {
            const dateMs = new Date(String(retryAfter)).getTime();
            if (!Number.isNaN(dateMs)) retryAfterMs = Math.max(0, dateMs - Date.now());
          }
        }
        message = `Rate limited by OpenSea (429)${retryAfterMs ? `, retry after ${retryAfterMs}ms` : ''}`;
        logger.warn(`[DROP_MINT] ${message}`);
        return { success: false, error: { code: errorCode, message, status, retryAfterMs } };
      } else if (status === 500 || status === 502 || status === 503) {
        errorCode = 'SERVER_ERROR';
        message = `OpenSea Drops API is currently unavailable (${status}). Will fallback to manual on-chain detection.`;
      } else {
        message = `OpenSea API error: ${status} - ${responseData?.errors?.[0] ?? err.message}`;
      }

      logger.warn(`[DROP_MINT] Error: ${message}`);
      return {
        success: false,
        error: { code: errorCode, message, status },
      };
    }

    logger.error(`[DROP_MINT] Unexpected error: ${err instanceof Error ? err.message : 'Unknown'}`);
    return {
      success: false,
      error: {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : 'Unexpected error',
        status: 0,
      },
    };
  }
}
