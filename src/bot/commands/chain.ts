import { promises as fs } from 'fs';
import path from 'path';
import type { Context } from 'telegraf';
import { config } from '../../config';
import { CHAIN_PROFILES, isChainKey, type ChainKey } from '../../chains';
import { logger } from '../../utils/logger';

/**
 * /chain — show or switch the active mint chain.
 *
 *   /chain            → show current chain + options
 *   /chain eth        → switch to Ethereum
 *   /chain robinhood  → switch to Robinhood Chain
 *
 * Switching rewrites MINT_CHAIN in the .env file and then exits the process.
 * PM2 restarts it automatically, and the new chain is picked up on boot
 * (the RPC client + config are singletons resolved once at startup, so a
 * clean restart is the safe way to swap networks).
 *
 * Admin-only (registered with adminOnly() middleware) because it changes which
 * network real funds are spent on.
 */

const ALIASES: Record<string, ChainKey> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  mainnet: 'ethereum',
  rh: 'robinhood',
  robinhood: 'robinhood',
  robinhoodchain: 'robinhood',
};

function resolveEnvPath(): string {
  // config loads .env from process.cwd(); match that.
  return path.resolve(process.cwd(), '.env');
}

async function setMintChainInEnv(envPath: string, target: ChainKey): Promise<void> {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    content = '';
  }
  const line = `MINT_CHAIN=${target}`;
  if (/^MINT_CHAIN=.*$/m.test(content)) {
    content = content.replace(/^MINT_CHAIN=.*$/m, line);
  } else {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += line + '\n';
  }
  await fs.writeFile(envPath, content, 'utf8');
}

function chainSummary(): string {
  const c = config.chain;
  return (
    `\ud83d\udd17 <b>Active Chain</b>\n\n` +
    `Network: <b>${c.label}</b>\n` +
    `Chain ID: <code>${c.chainId}</code>\n` +
    `OpenSea slug: <code>${c.openSeaSlug}</code>\n` +
    `Explorer: ${c.explorerName}\n\n` +
    `<b>Switch with:</b>\n` +
    `\u2022 <code>/chain eth</code> \u2014 Ethereum\n` +
    `\u2022 <code>/chain robinhood</code> \u2014 Robinhood Chain\n\n` +
    `<i>Switching restarts the bot (~5s) to load the new network.</i>`
  );
}

export async function chainCommand(ctx: Context): Promise<void> {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();

  // No argument → show current chain + help.
  if (!arg) {
    await ctx.reply(chainSummary(), { parse_mode: 'HTML' });
    return;
  }

  const target = ALIASES[arg];
  if (!target || !isChainKey(target)) {
    await ctx.reply(
      `\u274c Unknown chain "<code>${arg}</code>".\n\n` +
      `Valid: <code>eth</code> / <code>ethereum</code> or <code>rh</code> / <code>robinhood</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Already on that chain.
  if (target === config.chain.key) {
    await ctx.reply(
      `\u2705 Already on <b>${config.chain.label}</b> (chain ${config.chain.chainId}). No change.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const targetProfile = CHAIN_PROFILES[target];

  try {
    const envPath = resolveEnvPath();
    await setMintChainInEnv(envPath, target);
    logger.info(`[CHAIN] Admin switched MINT_CHAIN ${config.chain.key} -> ${target}. Restarting.`);
    await ctx.reply(
      `\ud83d\udd04 Switching <b>${config.chain.label}</b> \u2192 <b>${targetProfile.label}</b> (chain ${targetProfile.chainId}).\n\n` +
      `Restarting bot to load the new network. Give it ~5 seconds, then <code>/chain</code> to confirm.`,
      { parse_mode: 'HTML' }
    );
    // Give Telegram a beat to deliver the message before the process exits.
    setTimeout(() => {
      logger.info('[CHAIN] Exiting for PM2 restart to apply new chain.');
      process.exit(0);
    }, 1200);
  } catch (err) {
    logger.error(`[CHAIN] Failed to switch chain: ${err instanceof Error ? err.message : 'unknown'}`);
    await ctx.reply(
      `\u274c Failed to switch chain: ${err instanceof Error ? err.message : 'unknown error'}`,
      { parse_mode: 'HTML' }
    );
  }
}
