import { createPublicClient, http, fallback, type PublicClient } from 'viem';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getRankedRpcUrls, getRpcEndpoints, updateRpcLatency } from '../db/rpcEndpoints';

/**
 * Dynamic, latency-ranked RPC client.
 *
 * Endpoint source priority for the ACTIVE chain (config.chain.key):
 *   1. Custom endpoints in the DB (rpc_endpoints), ordered fastest-first by
 *      last measured latency. Managed via /add_rpc, /check_rpc, /rpcs.
 *   2. Fallback to the .env-configured primary + backup URLs when the DB has
 *      no enabled custom endpoints for this chain.
 *
 * The exported `publicClient` is a Proxy that always delegates to the current
 * underlying viem client, so callers can `import { publicClient }` once and
 * still pick up rebuilds after re-ranking (no restart needed).
 */

const chainKey = config.chain.key;

/** Ordered RPC URLs for the active chain, fastest-first, with .env fallback. */
export function getRankedUrls(): string[] {
  const custom = getRankedRpcUrls(chainKey);
  if (custom.length > 0) return custom;
  // Fallback: env primary then backup (dedupe).
  const fallbackUrls = [config.rpc.primaryRpcUrl, config.rpc.backupRpcUrl];
  return [...new Set(fallbackUrls)];
}

/** The single fastest RPC URL currently known for the active chain. */
export function getFastestRpcUrl(): string {
  return getRankedUrls()[0] ?? config.rpc.primaryRpcUrl;
}

function buildClient(): PublicClient {
  const urls = getRankedUrls();
  const safeUrls = urls.length > 0 ? urls : [config.rpc.primaryRpcUrl];
  const transports = safeUrls.map((u) => http(u, { retryCount: 2, retryDelay: 500 }));
  return createPublicClient({
    chain: config.chain.chain,
    // rank:false — we already ordered by measured latency; keep our order stable.
    transport: transports.length > 1 ? fallback(transports, { rank: false }) : transports[0]!,
  });
}

let activeClient: PublicClient = buildClient();

/** Rebuild the underlying client from the current ranked URL list. */
export function rebuildRpcClient(): void {
  activeClient = buildClient();
  logger.info(`[RPC] Client rebuilt for ${config.chain.label}. Order: ${getRankedUrls().join(', ')}`);
}

/** Stable proxy that always forwards to the current underlying client. */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop) {
    const value = (activeClient as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(activeClient) : value;
  },
});

/**
 * Probe a single RPC URL by timing an eth_blockNumber call.
 * Returns latency in ms, or null if the endpoint failed/timed out.
 */
export async function probeRpc(url: string, timeoutMs = 4000): Promise<number | null> {
  const probeClient = createPublicClient({
    chain: config.chain.chain,
    transport: http(url, { retryCount: 0, timeout: timeoutMs }),
  });
  const start = Date.now();
  try {
    await probeClient.getBlockNumber();
    return Date.now() - start;
  } catch {
    return null;
  }
}

export interface RpcProbeResult {
  url: string;
  label: string | null;
  latencyMs: number | null;
}

/**
 * Benchmark all custom endpoints for the active chain, persist their latency,
 * then rebuild the client so the fastest is used first. Returns sorted results.
 */
export async function benchmarkAndRank(): Promise<RpcProbeResult[]> {
  const endpoints = getRpcEndpoints(chainKey);
  if (endpoints.length === 0) return [];

  const results: RpcProbeResult[] = await Promise.all(
    endpoints.map(async (e) => {
      const latencyMs = await probeRpc(e.url);
      updateRpcLatency(chainKey, e.url, latencyMs);
      return { url: e.url, label: e.label, latencyMs };
    })
  );

  // Rebuild so the freshly-ranked order takes effect immediately.
  rebuildRpcClient();

  return results.sort((a, b) => {
    if (a.latencyMs === null) return 1;
    if (b.latencyMs === null) return -1;
    return a.latencyMs - b.latencyMs;
  });
}

export async function getLatestBaseFee(): Promise<bigint> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  if (!block.baseFeePerGas) {
    throw new Error('Could not retrieve baseFeePerGas from latest block');
  }
  return block.baseFeePerGas;
}

export async function getMaxPriorityFeePerGas(): Promise<bigint> {
  try {
    const feeHistory = await publicClient.getFeeHistory({
      blockCount: 4,
      rewardPercentiles: [25, 50, 75],
    });

    // Use median of the 50th percentile rewards from last 4 blocks
    const rewards = feeHistory.reward?.map(r => r[1]).filter((v): v is bigint => v !== undefined) || [];
    if (rewards.length === 0) {
      throw new Error('No priority fee data available');
    }

    // Calculate median
    const sorted = [...rewards].sort((a, b) => (a < b ? -1 : 1));
    const median = sorted[Math.floor(sorted.length / 2)];

    if (!median) {
      throw new Error('Could not calculate median priority fee');
    }

    logger.info(`[GAS] Network priority fee (median): ${Number(median) / 1e9} gwei`);
    return median;
  } catch (error) {
    logger.warn('[GAS] Failed to fetch network priority fee, using fallback');
    throw error;
  }
}

export async function getEthBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.getBalance({ address });
}
