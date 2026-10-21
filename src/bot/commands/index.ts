import type { Telegraf, Context } from 'telegraf';
import { startCommand, helpCommand } from './start';
import { mintCommand, mintMaxCommand, statusCommand, historyCommand, cancelCommand } from './mint';
import { dryRunCommand, executeDryRun } from './dryrun';
import { walletsCommand } from './wallet';
import { wlCommand } from './wl';
import { settingsCommand, setMaxPriceCommand, setMaxGasCommand, setQuantityCommand, setPriorityFeeCommand, settingsCallback } from './settings';
import { scheduleMintCommand, scheduleMintMaxCommand, listSchedulesCommand, cancelScheduleCommand, cancelScheduleCallback } from './schedule';
import {
  adminStatsCommand,
  adminReloadCommand,
  adminBlacklistCommand,
  blacklistCommand,
  whitelistCommand,
} from './admin';
import { adminOnly } from '../middleware/auth';
import { rateLimitMint } from '../middleware/rateLimit';
import { config } from '../../config';
import { confirmCommand, panicCommand, statusPlusCommand, addWalletCommand, confirmCallback, cancelConfirmCallback } from './ops';
import { chainCommand } from './chain';
import { addRpcCommand, listRpcCommand, checkRpcCommand, delRpcCommand, toggleRpcCommand } from './rpc';
import { apiCommand } from './api';
import {
  addProxyCommand,
  listProxyCommand,
  checkProxyCommand,
  delProxyCommand,
  clearProxiesCommand,
  toggleProxyCommand,
} from './proxy';

/**
 * When DRY_RUN_MODE is enabled, intercept mint commands and run a simulation
 * instead of a real mint. No transaction is ever sent in this mode.
 */
function dryRunGate(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context): Promise<void> => {
    if (!config.mint.dryRunMode) {
      return handler(ctx);
    }
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const url = text.trim().split(/\s+/)[1];
    if (!url) {
      return handler(ctx); // let the original command show its usage message
    }
    await ctx.reply(
      '\u26a0\ufe0f <b>DRY_RUN_MODE is active.</b> Running a simulation instead of a real mint. No transaction will be sent.',
      { parse_mode: 'HTML' }
    );
    await executeDryRun(ctx, url);
  };
}

export function registerCommands(bot: Telegraf<Context>): void {
  bot.command('start', startCommand);
  bot.command('help', helpCommand);

  bot.command('mint', rateLimitMint(), dryRunGate(mintCommand));
  bot.command('mint_max', rateLimitMint(), dryRunGate(mintMaxCommand));
  bot.command('dryrun', rateLimitMint(), dryRunCommand);
  bot.command('preflight', rateLimitMint(), dryRunCommand);
  bot.command('confirm', confirmCommand);
  bot.command('panic', adminOnly(), panicCommand);
  bot.command('status_plus', statusPlusCommand);
  bot.command('add_wallet', adminOnly(), addWalletCommand);
  bot.command('status', statusCommand);
  bot.command('chain', adminOnly(), chainCommand);
  bot.command('history', historyCommand);
  bot.command('cancel', cancelCommand);

  bot.command('wallets', walletsCommand);
  bot.command('wl', wlCommand);

  bot.command('schedule_mint', scheduleMintCommand);
  bot.command('schedule_mint_max', scheduleMintMaxCommand);
  bot.command('list_schedules', listSchedulesCommand);
  bot.command('cancel_schedule', cancelScheduleCommand);

  bot.command('settings', settingsCommand);
  bot.command('set_maxprice', setMaxPriceCommand);
  bot.command('set_maxgas', setMaxGasCommand);
  bot.command('set_quantity', setQuantityCommand);
  bot.command('set_priorityfee', setPriorityFeeCommand);

  // RPC management (fastest-first ranking + fallback)
  bot.command('rpcs', listRpcCommand);
  bot.command('check_rpc', checkRpcCommand);
  bot.command('add_rpc', adminOnly(), addRpcCommand);
  bot.command('del_rpc', adminOnly(), delRpcCommand);
  bot.command('toggle_rpc', adminOnly(), toggleRpcCommand);

  // OpenSea API key management (runtime override, no redeploy)
  bot.command('api', adminOnly(), apiCommand);

  // Proxy pool management (rotate OpenSea calls across IPs, bypass 429)
  bot.command('proxies', listProxyCommand);
  bot.command('check_proxy', checkProxyCommand);
  bot.command('add_proxy', adminOnly(), addProxyCommand);
  bot.command('del_proxy', adminOnly(), delProxyCommand);
  bot.command('clear_proxies', adminOnly(), clearProxiesCommand);
  bot.command('toggle_proxy', adminOnly(), toggleProxyCommand);

  bot.command('blacklist', adminOnly(), blacklistCommand);
  bot.command('whitelist', adminOnly(), whitelistCommand);
  bot.command('admin_stats', adminOnly(), adminStatsCommand);
  bot.command('admin_reload', adminOnly(), adminReloadCommand);
  bot.command('admin_blacklist', adminOnly(), adminBlacklistCommand);

  bot.action(/^confirm_mint:(\d{6})$/, async (ctx) => {
    await confirmCallback(ctx, ctx.match[1] ?? '');
  });

  bot.action(/^cancel_mint:(\d{6})$/, async (ctx) => {
    await cancelConfirmCallback(ctx, ctx.match[1] ?? '');
  });

  bot.action('wallets:refresh', async (ctx) => {
    await ctx.answerCbQuery('Refreshing balances');
    await walletsCommand(ctx);
  });

  bot.action(/^set:(maxprice|maxgas|qty|prio):([0-9.]+)$/, async (ctx) => {
    await settingsCallback(ctx, ctx.match[1] ?? '', ctx.match[2] || '');
  });

  bot.action(/^cancel_schedule:([a-f0-9-]{20,})$/, async (ctx) => {
    await cancelScheduleCallback(ctx, ctx.match[1] ?? '');
  });

}


