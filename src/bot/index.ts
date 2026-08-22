import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { registerCommands } from './commands/index';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  // Global error handler
  bot.catch((err, ctx) => {
    logger.error(`[BOT] Unhandled error for update ${ctx.updateType}: ${err instanceof Error ? err.message : 'unknown'}`);
  });

  registerCommands(bot);

  // Telegram slash-command menu shown when user types "/".
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Open main help' },
    { command: 'help', description: 'Show command guide' },
    { command: 'mint', description: 'Preflight + live mint with confirm button' },
    { command: 'mint_max', description: 'Mint max allowed quantity after preflight' },
    { command: 'preflight', description: 'Run safety preflight / dry-run' },
    { command: 'dryrun', description: 'Simulate mint without tx' },
    { command: 'wallets', description: 'Show wallet balances' },
    { command: 'chain', description: 'Show or switch mint chain (eth/robinhood)' },
    { command: 'status_plus', description: 'Full operator status' },
    { command: 'settings', description: 'Show settings + preset buttons' },
    { command: 'schedule_mint', description: 'Schedule mint by time' },
    { command: 'schedule_mint_max', description: 'Schedule mint with MAX quantity' },
    { command: 'list_schedules', description: 'List scheduled mints' },
    { command: 'panic', description: 'Emergency stop queued/pending mints' },
    { command: 'confirm', description: 'Manual confirm fallback' },
    { command: 'add_wallet', description: 'Add burner wallet' },
    { command: 'history', description: 'Show recent mint jobs' },
    { command: 'cancel', description: 'Cancel a queued job' },
    { command: 'admin_reload', description: 'Reload wallet pool' },
  ]).catch((err) => {
    logger.warn(`[BOT] Failed to set command menu: ${err instanceof Error ? err.message : 'unknown'}`);
  });

  logger.info('[BOT] Bot initialized');
  return bot;
}
