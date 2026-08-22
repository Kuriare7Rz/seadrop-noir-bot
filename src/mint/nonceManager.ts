import { publicClient } from '../rpc/client';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Per-wallet nonce prefetch + lease manager (snipe fast-path).
 *
 * Goal: remove the blocking nonce RPC round-trip from the T-0 hot path.
 * The nonce (and chainId) are fetched during PRE-ARM (T-minus), cached
 * locally, and leased at fire time with zero network I/O. After a tx is
 * broadcast the local nonce is advanced optimistically; if local state ever
 * looks invalid, callers can force a chain reconcile.
 *
 * Scope: one wallet is assigned to one mint job at a time (see walletPool),
 * so a simple per-address counter is race-free within a session.
 */

interface NonceState {
  /** next nonce to use for this wallet (local view) */
  next: number;
  /** chainId the nonce was fetched for */
  chainId: number;
  /** monotonic-ish timestamp of last chain fetch (ms) */
  fetchedAt: number;
}

const state = new Map<string, NonceState>();

function key(address: string): string {
  return address.toLowerCase();
}

/**
 * Fetch the wallet's pending nonce from chain and cache it. Call during
 * pre-arm, BEFORE the mint window opens. Idempotent — safe to call repeatedly.
 */
export async function prefetchNonce(address: `0x${string}`): Promise<number> {
  const chainId = config.chain.chain.id;
  // 'pending' so queued-but-unmined txs from this wallet are accounted for.
  const next = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
  state.set(key(address), { next, chainId, fetchedAt: Date.now() });
  logger.info(`[NONCE] Pre-armed ${address.slice(0, 8)}... nonce=${next} (chainId=${chainId})`);
  return next;
}

/**
 * Lease the next nonce for this wallet with NO network I/O. Returns the cached
 * nonce and advances the local counter. Throws if the wallet was never
 * pre-armed for the active chain, so the caller can fall back to a safe path.
 */
export function leaseNonce(address: `0x${string}`): { nonce: number; chainId: number } {
  const s = state.get(key(address));
  const chainId = config.chain.chain.id;
  if (!s || s.chainId !== chainId) {
    throw new Error(`Nonce not pre-armed for ${address.slice(0, 8)}... on chainId ${chainId}`);
  }
  const nonce = s.next;
  s.next = nonce + 1;
  return { nonce, chainId };
}

/** True when a valid cached nonce exists for this wallet on the active chain. */
export function hasNonce(address: `0x${string}`): boolean {
  const s = state.get(key(address));
  return !!s && s.chainId === config.chain.chain.id;
}

/**
 * Re-sync local nonce from chain (e.g. after a rejected/dropped tx or when
 * local state is suspected invalid). Overwrites the cached value.
 */
export async function reconcileNonce(address: `0x${string}`): Promise<number> {
  return prefetchNonce(address);
}

/** Roll the local nonce back by one (call when a lease was NOT broadcast). */
export function releaseNonce(address: `0x${string}`): void {
  const s = state.get(key(address));
  if (s && s.next > 0) s.next -= 1;
}

/** Drop cached nonce for a wallet (e.g. on wallet release at job end). */
export function clearNonce(address: `0x${string}`): void {
  state.delete(key(address));
}
