import 'dotenv/config';
import { createBot } from './bot/index';
import { walletPool } from './wallet/pool';
import { startBalanceChecker } from './wallet/balanceChecker';
import { initWorker } from './queue/mintWorker';
import { startScheduler, stopScheduler } from './scheduler/index';
import { logger } from './utils/logger';
import { benchmarkAndRank, getRankedUrls } from './rpc/client';
import { getRpcEndpoints } from './db/rpcEndpoints';
import { checkClockDrift } from './utils/clockCheck';
import { config } from './config';

async function main(): Promise<void> {
  logger.info('[MAIN] Starting SeaDrop Mint Bot...');

  // Init wallet pool
  walletPool.init();
  const walletCount = walletPool.getWalletCount();
  if (walletCount === 0) {
    logger.error('[MAIN] No wallets loaded. Add at least WALLET_1_KEY to .env');
    process.exit(1);
  }
  logger.info(`[MAIN] Loaded ${walletCount} wallet(s)`);

  // Clock-drift sanity check (snipe timing depends on an accurate clock).
  await checkClockDrift();

  // Benchmark + rank custom RPCs for the active chain (fastest-first).
  const rpcCount = getRpcEndpoints(config.chain.key, true).length;
  if (rpcCount > 0) {
    logger.info(`[MAIN] Benchmarking ${rpcCount} custom RPC(s) for ${config.chain.label}...`);
    try {
      const ranked = await benchmarkAndRank();
      const fastest = ranked.find((r) => r.latencyMs !== null);
      if (fastest) logger.info(`[RPC] Fastest: ${fastest.url} (${fastest.latencyMs}ms)`);
    } catch (err) {
      logger.warn(`[RPC] Startup benchmark failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  } else {
    logger.info(`[RPC] No custom RPCs; using .env fallback: ${getRankedUrls().join(', ')}`);
  }

  // Create bot
  const bot = createBot();

  // Init queue worker
  await initWorker(bot);

  // Start balance checker
  startBalanceChecker(bot);

  // Start scheduler for scheduled mints
  startScheduler();

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('[MAIN] SIGINT received, shutting down...');
    stopScheduler();
    bot.stop('SIGINT');
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    logger.info('[MAIN] SIGTERM received, shutting down...');
    stopScheduler();
    bot.stop('SIGTERM');
    process.exit(0);
  });

  // Launch bot
  await bot.launch();
  logger.info('[MAIN] Bot is running and polling for updates');
}

main().catch((err) => {
  logger.error(`[MAIN] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
