import type { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEther } from 'viem';
import { walletPool } from '../../wallet/pool';
import { getQueueStats, panicQueue } from '../../queue/mintQueue';
import { getActiveJobs, createJob } from '../../db/mintJobs';
import { config } from '../../config';
import { consumePendingMint, clearPendingMints, getPendingMintCount, cancelPendingMint } from './safety';
import { addMintJob } from '../../queue/mintQueue';
import { v4 as uuidv4 } from 'uuid';

function envPath(): string {
  return path.join(process.cwd(), '.env');
}

function readEnvLines(): string[] {
  return fs.readFileSync(envPath(), 'utf8').split(/\n/);
}

function writeEnvLines(lines: string[]): void {
  fs.writeFileSync(envPath(), lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(envPath(), 0o600);
}

export async function confirmCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const code = text.trim().split(/\s+/)[1];
  if (!code) {
    await ctx.reply('❌ Usage: /confirm <code>', { parse_mode: 'HTML' });
    return;
  }
  const pending = consumePendingMint(telegramId, code);
  if (!pending) {
    await ctx.reply('❌ Confirmation code not found or expired. Run /mint again.', { parse_mode: 'HTML' });
    return;
  }
  const jobId = uuidv4();
  createJob({ id: jobId, telegram_id: telegramId });
  await ctx.reply(
    `🚀 <b>Confirmed — mint queued</b>\n\nJob: <code>${jobId}</code>\nURL: <code>${pending.url}</code>`,
    { parse_mode: 'HTML' }
  );
  await addMintJob({
    telegramId,
    url: pending.url,
    jobId,
    forceMaxQuantity: pending.forceMaxQuantity,
    walletRange: pending.walletRange,
  }, jobId);
}

export async function panicCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const clearedPending = clearPendingMints(telegramId);
  const clearedQueue = panicQueue();
  await ctx.reply(
    `🛑 <b>PANIC STOP</b>\n\nCleared confirmations: <b>${clearedPending}</b>\nCleared queued jobs: <b>${clearedQueue}</b>\n\nAlready-broadcast tx cannot be cancelled here.`,
    { parse_mode: 'HTML' }
  );
}

export async function statusPlusCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  await walletPool.updateBalances();
  const wallets = walletPool.getPoolStatus();
  const activeJobs = getActiveJobs(telegramId);
  const q = getQueueStats();
  const totalWei = wallets.reduce((sum, w) => sum + parseEther(w.balanceEth), 0n);
  const totalEth = Number(totalWei) / 1e18;
  const low = wallets.filter((w) => parseFloat(w.balanceEth) < parseFloat(config.mint.lowBalanceThresholdEth)).length;
  await ctx.reply(
    `📊 <b>SeaDrop Bot Status+</b>\n\n` +
    `Mode: <b>${config.mint.dryRunMode ? 'DRY RUN' : 'LIVE + CONFIRM'}</b>\n` +
    `Wallets: <b>${wallets.length}</b> (${wallets.filter(w=>w.status==='IDLE').length} idle / ${wallets.filter(w=>w.status==='BUSY').length} busy)\n` +
    `Total ETH: <b>${totalEth.toFixed(6)}</b>\n` +
    `Low balance wallets: <b>${low}</b>\n` +
    `Queue: <b>${q.active}</b> active / <b>${q.pending}</b> pending\n` +
    `Active jobs: <b>${activeJobs.length}</b>\n` +
    `Pending confirmations: <b>${getPendingMintCount(telegramId)}</b>\n` +
    `Max price: <b>${config.mint.defaultMaxMintPriceEth} ETH</b>\n` +
    `Max gas: <b>${config.mint.defaultMaxGasEth} ETH</b>\n` +
    `Priority fee cap/default: <b>${config.mint.maxPriorityFeeGwei} gwei</b>`,
    { parse_mode: 'HTML' }
  );
}

export async function addWalletCommand(ctx: Context): Promise<void> {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const key = text.trim().split(/\s+/)[1];
  if (!key) {
    await ctx.reply('❌ Usage: /add_wallet <private_key>\nUse burner wallets only.', { parse_mode: 'HTML' });
    return;
  }
  const pk = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
  let address: string;
  try {
    address = privateKeyToAccount(pk).address;
  } catch (err) {
    await ctx.reply('❌ Invalid private key.', { parse_mode: 'HTML' });
    return;
  }
  const lines = readEnvLines();
  const existing = lines.filter((l) => /^WALLET_\d+_KEY=/.test(l));
  const already = existing.some((l) => l.split('=')[1]?.toLowerCase() === pk.toLowerCase());
  if (already) {
    await ctx.reply(`ℹ️ Wallet already exists: <code>${address}</code>`, { parse_mode: 'HTML' });
    return;
  }
  const next = existing.length + 1;
  lines.push(`WALLET_${next}_KEY=${pk}`);
  writeEnvLines(lines);
  process.env[`WALLET_${next}_KEY`] = pk;
  walletPool.reloadFromEnv();
  await walletPool.updateBalances();
  await ctx.reply(`✅ Added wallet #${next}\nAddress: <code>${address}</code>\nPool reloaded.`, { parse_mode: 'HTML' });
}


async function queueConfirmedMint(ctx: Context, telegramId: string, code: string): Promise<void> {
  const pending = consumePendingMint(telegramId, code);
  if (!pending) {
    await ctx.reply('❌ Confirmation not found or expired. Run /mint again.', { parse_mode: 'HTML' });
    return;
  }
  const jobId = uuidv4();
  createJob({ id: jobId, telegram_id: telegramId });
  await ctx.reply(
    `🚀 <b>Confirmed — mint queued</b>\n\nJob: <code>${jobId}</code>\nURL: <code>${pending.url}</code>`,
    { parse_mode: 'HTML' }
  );
  await addMintJob({
    telegramId,
    url: pending.url,
    jobId,
    forceMaxQuantity: pending.forceMaxQuantity,
    walletRange: pending.walletRange,
  }, jobId);
}

export async function confirmCallback(ctx: Context, code: string): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  if ('answerCbQuery' in ctx) await ctx.answerCbQuery('Mint confirmed');
  await queueConfirmedMint(ctx, telegramId, code);
}

export async function cancelConfirmCallback(ctx: Context, code: string): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const cancelled = cancelPendingMint(telegramId, code);
  if ('answerCbQuery' in ctx) await ctx.answerCbQuery(cancelled ? 'Cancelled' : 'Already expired');
  await ctx.reply(cancelled ? '❌ Pending mint cancelled.' : 'ℹ️ Pending mint was already expired/cancelled.', { parse_mode: 'HTML' });
}
