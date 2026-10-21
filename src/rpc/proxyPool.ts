import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getEnabledProxyUrls, getProxies, updateProxyHealth } from '../db/proxies';

/**
 * Proxy pool for OpenSea API calls.
 *
 * Why: OpenSea rate-limits per IP. Firing many wallets from one server IP
 * triggers 429. Rotating each wallet's OpenSea request through a different
 * proxy makes them appear as many IPs, bypassing the per-IP limit.
 *
 * Rotation is deterministic per wallet index (walletIndex % poolSize) so a
 * given wallet consistently uses the same proxy within a run, spreading load
 * evenly. When the pool is empty, callers use the server's direct connection.
 */

// Cache built agents so we don't rebuild per request.
const agentCache = new Map<string, HttpsProxyAgent>();

function buildAgent(proxyUrl: string): HttpsProxyAgent {
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl);
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

/** True when proxy rotation is enabled AND at least one enabled proxy exists. */
export function proxyPoolActive(): boolean {
  return config.proxy.enabled && getEnabledProxyUrls().length > 0;
}

/**
 * Pick a proxy agent for a given wallet index. Returns undefined when no proxy
 * should be used (disabled or empty pool) — caller then goes direct.
 */
export function getProxyAgentForWallet(walletIndex: number | null): HttpsProxyAgent | undefined {
  if (!config.proxy.enabled) return undefined;
  const urls = getEnabledProxyUrls();
  if (urls.length === 0) return undefined;
  const idx = walletIndex == null ? 0 : Math.abs(walletIndex);
  const url = urls[idx % urls.length]!;
  return buildAgent(url);
}

/** The proxy URL that would be used for a wallet index (for logging). */
export function getProxyUrlForWallet(walletIndex: number | null): string | null {
  if (!config.proxy.enabled) return null;
  const urls = getEnabledProxyUrls();
  if (urls.length === 0) return null;
  const idx = walletIndex == null ? 0 : Math.abs(walletIndex);
  return urls[idx % urls.length]!;
}

export interface ProxyProbeResult {
  url: string;
  label: string | null;
  latencyMs: number | null;
  exitIp: string | null;
}

/**
 * Health-check every proxy by hitting a fast IP-echo endpoint through it.
 * Records latency + ok state, and returns the observed exit IP so the user can
 * confirm each proxy really is a distinct IP.
 */
export async function checkAllProxies(): Promise<ProxyProbeResult[]> {
  const proxies = getProxies();
  if (proxies.length === 0) return [];

  const results = await Promise.all(
    proxies.map(async (p): Promise<ProxyProbeResult> => {
      const start = Date.now();
      try {
        const agent = buildAgent(p.url);
        const res = await axios.get('https://api.ipify.org?format=json', {
          httpsAgent: agent,
          timeout: config.proxy.checkTimeoutMs,
          proxy: false, // use the agent, not axios' own proxy handling
        });
        const latencyMs = Date.now() - start;
        const exitIp = (res.data && (res.data as { ip?: string }).ip) || null;
        updateProxyHealth(p.url, latencyMs);
        return { url: p.url, label: p.label, latencyMs, exitIp };
      } catch {
        updateProxyHealth(p.url, null);
        return { url: p.url, label: p.label, latencyMs: null, exitIp: null };
      }
    })
  );

  return results.sort((a, b) => {
    if (a.latencyMs === null) return 1;
    if (b.latencyMs === null) return -1;
    return a.latencyMs - b.latencyMs;
  });
}

export function clearAgentCache(): void {
  agentCache.clear();
}
