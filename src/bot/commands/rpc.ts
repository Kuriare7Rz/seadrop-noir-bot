import type { Context } from 'telegraf';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { logAction } from '../../db/auditLogs';
import {
  addRpcEndpoint,
  removeRpcEndpoint,
  getRpcEndpoints,
  setRpcEnabled,
} from '../../db/rpcEndpoints';
import { benchmarkAndRank, rebuildRpcClient, getRankedUrls } from '../../rpc/client';

const chainKey = config.chain.key;
const chainLabel = config.chain.label;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidRpcUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

/** /add_rpc <url> [label] — register a custom RPC for the active chain. */
export async function addRpcCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/).slice(1);
  const url = parts[0];
  const label = parts.slice(1).join(' ') || undefined;

  if (!url) {
    await ctx.reply(
      `Usage: <code>/add_rpc &lt;url&gt; [label]</code>\nActive chain: <b>${esc(chainLabel)}</b>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (!isValidRpcUrl(url)) {
    await ctx.reply('\u274c Invalid RPC URL. Must start with http(s):// or wss://', { parse_mode: 'HTML' });
    return;
  }

  addRpcEndpoint(chainKey, url, label, telegramId);
  logAction(telegramId, 'RPC_ADD', { chainKey, url, label });
  logger.info(`[RPC] Added ${url} for ${chainKey} by ${telegramId}`);
  rebuildRpcClient();

  await ctx.reply(
    `\u2705 RPC added for <b>${esc(chainLabel)}</b>:\n<code>${esc(url)}</code>\n\nRun <code>/check_rpc</code> to benchmark &amp; rank.`,
    { parse_mode: 'HTML' }
  );
}

/** /rpcs — list custom RPCs for the active chain with latency + order. */
export async function listRpcCommand(ctx: Context): Promise<void> {
  const endpoints = getRpcEndpoints(chainKey);
  if (endpoints.length === 0) {
    await ctx.reply(
      `No custom RPCs for <b>${esc(chainLabel)}</b>. Using .env fallback:\n` +
        getRankedUrls().map((u) => `\u2022 <code>${esc(u)}</code>`).join('\n') +
        `\n\nAdd one with <code>/add_rpc &lt;url&gt;</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const lines = endpoints.map((e, i) => {
    const lat = e.last_latency_ms === null ? 'untested' : `${e.last_latency_ms}ms`;
    const state = e.enabled ? '' : ' <i>(disabled)</i>';
    const name = e.label ? ` — ${esc(e.label)}` : '';
    return `${i + 1}. <code>${esc(e.url)}</code>${name}\n    ${lat}${state}`;
  });

  await ctx.reply(
    `<b>RPCs for ${esc(chainLabel)}</b> (fastest-first)\n\n${lines.join('\n')}\n\n` +
      `<code>/check_rpc</code> re-benchmark \u00b7 <code>/del_rpc &lt;url|#&gt;</code> remove`,
    { parse_mode: 'HTML' }
  );
}

/** /check_rpc — benchmark all custom RPCs, persist latency, re-rank. */
export async function checkRpcCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const endpoints = getRpcEndpoints(chainKey);
  if (endpoints.length === 0) {
    await ctx.reply(
      `No custom RPCs to benchmark for <b>${esc(chainLabel)}</b>. Add one with <code>/add_rpc &lt;url&gt;</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.reply(`\u23f1\ufe0f Benchmarking ${endpoints.length} RPC(s) for <b>${esc(chainLabel)}</b>...`, {
    parse_mode: 'HTML',
  });

  const results = await benchmarkAndRank();
  logAction(telegramId, 'RPC_CHECK', { chainKey, results: results.map((r) => ({ url: r.url, latencyMs: r.latencyMs })) });

  const lines = results.map((r, i) => {
    const lat = r.latencyMs === null ? '\u274c dead' : `${r.latencyMs}ms`;
    const medal = r.latencyMs === null ? '\u2022' : i === 0 ? '\ud83e\udd47' : `${i + 1}.`;
    const name = r.label ? ` — ${esc(r.label)}` : '';
    return `${medal} <code>${esc(r.url)}</code>${name}\n    ${lat}`;
  });

  const fastest = results.find((r) => r.latencyMs !== null);
  const summary = fastest
    ? `\u2705 Fastest: <code>${esc(fastest.url)}</code> (${fastest.latencyMs}ms) \u2014 now primary.`
    : '\u26a0\ufe0f All endpoints failed. Falling back to .env RPC.';

  await ctx.reply(
    `<b>RPC Benchmark \u2014 ${esc(chainLabel)}</b>\n\n${lines.join('\n')}\n\n${summary}`,
    { parse_mode: 'HTML' }
  );
}

/** /del_rpc <url|#> — remove a custom RPC. */
export async function delRpcCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const arg = text.trim().split(/\s+/)[1];

  if (!arg) {
    await ctx.reply('Usage: <code>/del_rpc &lt;url&gt;</code> (or the list number from /rpcs)', { parse_mode: 'HTML' });
    return;
  }

  // Allow deletion by list index shown in /rpcs.
  let target = arg;
  const asIdx = Number(arg);
  if (Number.isInteger(asIdx) && asIdx >= 1) {
    const endpoints = getRpcEndpoints(chainKey);
    const picked = endpoints[asIdx - 1];
    if (picked) target = picked.url;
  }

  const removed = removeRpcEndpoint(chainKey, target);
  if (!removed) {
    await ctx.reply(`\u274c No matching RPC found for <b>${esc(chainLabel)}</b>.`, { parse_mode: 'HTML' });
    return;
  }
  logAction(telegramId, 'RPC_DEL', { chainKey, target });
  rebuildRpcClient();
  await ctx.reply(`\u2705 Removed RPC and re-ranked.`, { parse_mode: 'HTML' });
}

/** /toggle_rpc <url> — enable/disable an RPC without deleting it. */
export async function toggleRpcCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const arg = text.trim().split(/\s+/)[1];
  if (!arg) {
    await ctx.reply('Usage: <code>/toggle_rpc &lt;url&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const endpoints = getRpcEndpoints(chainKey);
  const match = endpoints.find((e) => e.url === arg);
  if (!match) {
    await ctx.reply('\u274c RPC not found. See <code>/rpcs</code>.', { parse_mode: 'HTML' });
    return;
  }
  const next = match.enabled ? false : true;
  setRpcEnabled(chainKey, arg, next);
  logAction(telegramId, 'RPC_TOGGLE', { chainKey, url: arg, enabled: next });
  rebuildRpcClient();
  await ctx.reply(`\u2705 RPC ${next ? 'enabled' : 'disabled'} and re-ranked.`, { parse_mode: 'HTML' });
}
