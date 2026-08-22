import dotenv from 'dotenv';
import { z } from 'zod';
import { CHAIN_PROFILES, isChainKey, type ChainKey } from '../chains';

dotenv.config();

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  ADMIN_TELEGRAM_ID: z.string().min(1, 'ADMIN_TELEGRAM_ID is required'),

  // Chain selection — which network to mint on. Default: ethereum (unchanged behavior).
  MINT_CHAIN: z.string().default('ethereum'),

  // RPC
  ALCHEMY_API_KEY: z.string().min(1, 'ALCHEMY_API_KEY is required'),
  BACKUP_RPC_URL: z.string().url().default('https://cloudflare-eth.com'),
  // Robinhood Chain RPC (used when MINT_CHAIN=robinhood). Has a working public default.
  ROBINHOOD_RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),

  // OpenSea
  OPENSEA_API_KEY: z.string().min(1, 'OPENSEA_API_KEY is required'),

  // Etherscan
  ETHERSCAN_API_KEY: z.string().min(1, 'ETHERSCAN_API_KEY is required'),

  // Mint defaults
  DEFAULT_MAX_MINT_PRICE_ETH: z.string().default('0.1'),
  DEFAULT_MAX_GAS_ETH: z.string().default('0.02'),
  DEFAULT_QUANTITY: z.string().default('1'),
  LOW_BALANCE_THRESHOLD_ETH: z.string().default('0.05'),
  // Push low-balance warnings to Telegram. Off by default: with many fleet
  // wallets (most intentionally empty) this spams the chat every cycle.
  // Balance is still checked, logged, and used by preflight regardless.
  LOW_BALANCE_ALERTS: z.string().default('false'),
  MAX_PRIORITY_FEE_GWEI: z.string().default('0.1'),
  TX_TIMEOUT_SECONDS: z.string().default('300'),
  QUEUE_CONCURRENCY: z.string().default('10'),

  // Multi-wallet mint concurrency (how many wallets mint in parallel)
  MULTI_WALLET_CONCURRENCY: z.string().default('5'),
  MULTI_WALLET_PROGRESS_INTERVAL: z.string().default('10'),

  // Rate limiting
  RATE_LIMIT_MAX: z.string().default('5'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000'),

  // GoPlus
  GOPLUS_STRICT_MODE: z.string().default('false'),

  // Dry run — when true, every /mint command runs as a simulation
  DRY_RUN_MODE: z.string().default('false'),

  // Window guard — when a drop's public/eligible stage has not opened yet,
  // poll until it opens instead of firing early and hitting 422 NOT_ELIGIBLE.
  WINDOW_GUARD_ENABLED: z.string().default('true'),
  // Max seconds to wait for the stage window to open before giving up.
  WINDOW_GUARD_MAX_WAIT_SECONDS: z.string().default('900'),
  // Poll interval (ms) while waiting for the window to open.
  WINDOW_GUARD_POLL_MS: z.string().default('3000'),
  // Auto-align /schedule time to the drop's public stage start when the
  // requested time falls before the mintable window.
  SCHEDULE_AUTO_ALIGN: z.string().default('true'),

  // ===== SNIPE MODE (default ON for scheduled mints) =====
  // When a scheduled mint fires, hammer OpenSea /mint from just before the
  // window opens until it returns 200 + signature, then broadcast instantly.
  SNIPE_ENABLED: z.string().default('true'),
  // Auto benchmark + re-rank RPCs during snipe pre-arm (before window opens),
  // so the fastest RPC is always used without a manual /check_rpc first.
  SNIPE_RPC_PRECHECK: z.string().default('true'),
  // Blast the signed mint tx to ALL ranked RPCs simultaneously (first landing
  // wins). Only kicks in when >1 RPC is configured; else single-RPC send.
  SNIPE_PARALLEL_BROADCAST: z.string().default('true'),
  // Max seconds to keep hammering before giving up.
  SNIPE_MAX_HAMMER_SECONDS: z.string().default('60'),
  // The following are CHAIN-AWARE: leave blank to use the active chain's tuned
  // profile (see src/chains.ts). Set a value to force-override for all chains.
  // Start hammering this many ms BEFORE the target/stage open time.
  SNIPE_LEAD_MS: z.string().default(''),
  // Interval (ms) between /mint attempts while hammering.
  SNIPE_HAMMER_INTERVAL_MS: z.string().default(''),
  // Priority fee (gwei) on the snipe fast-path. Robinhood profile uses 0 (no gas market).
  SNIPE_PRIORITY_FEE_GWEI: z.string().default(''),
  // Fixed gas limit (units) used on snipe fast-path to skip estimateGas RPC.
  SNIPE_GAS_LIMIT: z.string().default(''),
  // maxFeePerGas headroom = baseFee * this multiplier + priority fee.
  SNIPE_BASEFEE_MULTIPLIER: z.string().default(''),

  // --- Proxy rotation for OpenSea API (bypass per-IP 429 rate limits) ---
  // Master switch. Even when 'true', rotation only activates if the proxy pool
  // (managed via /add_proxy, DB-backed) has at least one enabled proxy.
  PROXY_ENABLED: z.string().default('true'),
  // Timeout (ms) for proxy health checks (/check_proxy).
  PROXY_CHECK_TIMEOUT_MS: z.string().default('8000'),

  // --- 429 backoff + jitter (softens rate limits even without proxies) ---
  // On HTTP 429 during hammer, wait Retry-After (if given) or this base (ms).
  RATE_LIMIT_BACKOFF_MS: z.string().default('1000'),
  // Random extra 0..N ms added to each hammer attempt so N wallets don't hit
  // OpenSea at the exact same millisecond (spreads the burst).
  HAMMER_JITTER_MS: z.string().default('120'),

});

function loadWalletKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const key = process.env[`WALLET_${i}_KEY`];
    if (key && key.trim().length > 0) {
      keys.push(key.trim());
    }
  }
  return keys;
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[CONFIG] Invalid environment variables:');
  parsed.error.errors.forEach((err) => {
    console.error(`  - ${err.path.join('.')}: ${err.message}`);
  });
  process.exit(1);
}

const env = parsed.data;

// Resolve active chain profile from MINT_CHAIN (validated, falls back to ethereum).
const chainKey: ChainKey = isChainKey(env.MINT_CHAIN) ? env.MINT_CHAIN : 'ethereum';
if (!isChainKey(env.MINT_CHAIN)) {
  console.warn(`[CONFIG] Unknown MINT_CHAIN="${env.MINT_CHAIN}", falling back to "ethereum". Valid: ethereum, robinhood`);
}
const activeChain = CHAIN_PROFILES[chainKey];

// Primary RPC differs per chain: Alchemy for Ethereum, public RPC for Robinhood Chain.
const primaryRpcUrl =
  chainKey === 'robinhood'
    ? env.ROBINHOOD_RPC_URL
    : `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const backupRpcUrl = chainKey === 'robinhood' ? env.ROBINHOOD_RPC_URL : env.BACKUP_RPC_URL;

export const config = {
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    adminTelegramId: env.ADMIN_TELEGRAM_ID,
  },
  chain: activeChain,
  rpc: {
    alchemyApiKey: env.ALCHEMY_API_KEY,
    primaryRpcUrl,
    backupRpcUrl,
  },
  opensea: {
    apiKey: env.OPENSEA_API_KEY,
    baseUrl: 'https://api.opensea.io',
  },
  proxy: {
    enabled: env.PROXY_ENABLED === 'true',
    checkTimeoutMs: parseInt(env.PROXY_CHECK_TIMEOUT_MS, 10),
  },
  etherscan: {
    apiKey: env.ETHERSCAN_API_KEY,
    baseUrl: 'https://api.etherscan.io',
  },
  mint: {
    defaultMaxMintPriceEth: env.DEFAULT_MAX_MINT_PRICE_ETH,
    defaultMaxGasEth: env.DEFAULT_MAX_GAS_ETH,
    defaultQuantity: parseInt(env.DEFAULT_QUANTITY, 10),
    lowBalanceThresholdEth: env.LOW_BALANCE_THRESHOLD_ETH,
    lowBalanceAlerts: env.LOW_BALANCE_ALERTS === 'true',
    maxPriorityFeeGwei: parseFloat(env.MAX_PRIORITY_FEE_GWEI),
    txTimeoutSeconds: parseInt(env.TX_TIMEOUT_SECONDS, 10),
    queueConcurrency: parseInt(env.QUEUE_CONCURRENCY, 10),
    dryRunMode: env.DRY_RUN_MODE === 'true',
    multiWalletConcurrency: parseInt(env.MULTI_WALLET_CONCURRENCY, 10),
    multiWalletProgressInterval: parseInt(env.MULTI_WALLET_PROGRESS_INTERVAL, 10),
    windowGuardEnabled: env.WINDOW_GUARD_ENABLED === 'true',
    windowGuardMaxWaitSeconds: parseInt(env.WINDOW_GUARD_MAX_WAIT_SECONDS, 10),
    windowGuardPollMs: parseInt(env.WINDOW_GUARD_POLL_MS, 10),
    scheduleAutoAlign: env.SCHEDULE_AUTO_ALIGN === 'true',
    snipeEnabled: env.SNIPE_ENABLED === 'true',
    snipeRpcPrecheck: env.SNIPE_RPC_PRECHECK === 'true',
    snipeParallelBroadcast: env.SNIPE_PARALLEL_BROADCAST === 'true',
    snipeMaxHammerSeconds: parseInt(env.SNIPE_MAX_HAMMER_SECONDS, 10),
    rateLimitBackoffMs: parseInt(env.RATE_LIMIT_BACKOFF_MS, 10),
    hammerJitterMs: parseInt(env.HAMMER_JITTER_MS, 10),
    // Chain-aware: empty env -> active chain profile value.
    snipeLeadMs: env.SNIPE_LEAD_MS.trim() !== '' ? parseInt(env.SNIPE_LEAD_MS, 10) : activeChain.snipe.leadMs,
    snipeHammerIntervalMs: env.SNIPE_HAMMER_INTERVAL_MS.trim() !== '' ? parseInt(env.SNIPE_HAMMER_INTERVAL_MS, 10) : activeChain.snipe.hammerIntervalMs,
    snipePriorityFeeGwei: env.SNIPE_PRIORITY_FEE_GWEI.trim() !== '' ? parseFloat(env.SNIPE_PRIORITY_FEE_GWEI) : activeChain.snipe.priorityFeeGwei,
    snipeGasLimit: env.SNIPE_GAS_LIMIT.trim() !== '' ? BigInt(env.SNIPE_GAS_LIMIT) : activeChain.snipe.gasLimit,
    snipeBaseFeeMultiplier: env.SNIPE_BASEFEE_MULTIPLIER.trim() !== '' ? parseFloat(env.SNIPE_BASEFEE_MULTIPLIER) : activeChain.snipe.baseFeeMultiplier,
  },
  rateLimit: {
    max: parseInt(env.RATE_LIMIT_MAX, 10),
    windowMs: parseInt(env.RATE_LIMIT_WINDOW_MS, 10),
  },
  goplus: {
    strictMode: env.GOPLUS_STRICT_MODE === 'true',
    baseUrl: 'https://api.gopluslabs.io',
  },
  walletKeys: loadWalletKeys(),
} as const;

export type Config = typeof config;
