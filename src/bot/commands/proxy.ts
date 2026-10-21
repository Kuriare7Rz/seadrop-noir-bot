import type { Context } from 'telegraf';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { logAction } from '../../db/auditLogs';
import {
  addProxy,
  addProxiesBulk,
  removeProxy,
  clearProxies,
  getProxies,
  getProxyCount,
  setProxyEnabled,
} from '../../db/proxies';
import { checkAllProxies, clearAgentCache, proxyPoolActive } from '../../rpc/proxyPool';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Hide credentials in a proxy URL for display. */
function maskProxy(url: string): string {
  return esc(url.replace(/\/\/[^@/]*@/, '//***@'));
}

function isValidProxyUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return ['http:', 'https:', 'socks:', 'socks5:', 'socks4:'].includes(p.protocol);
  } catch {
    return false;
  }
}

/**
 * /add_proxy <url> [label]  — single
 * /add_proxy (multiline)    — bulk: one proxy URL per line after the command
 * Accepts http(s)://user:pass@host:port and socks5://...
 */
export async function addProxyCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

  // Split off the command word; keep the rest (may be multiline for bulk).
  const rest = text.replace(/^\/add_proxy(@\S+)?\s*/i, '').trim();
  if (!rest) {
    await ctx.reply(
      'Usage:\n' +
        '<code>/add_proxy &lt;url&gt; [label]</code>\n\n' +
        'Bulk (one per line):\n' +
        '<code>/add_proxy\nhttp://user:pass@ip1:port\nhttp://user:pass@ip2:port</code>\n\n' +
        'Formats: <code>http(s)://user:pass@host:port</code>, <code>socks5://host:port</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const lines = rest.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Bulk mode: multiple lines.
  if (lines.length > 1) {
    const valid = lines.filter(isValidProxyUrl);
    const invalid = lines.length - valid.length;
    const n = addProxiesBulk(valid, telegramId);
    clearAgentCache();
    logAction(telegramId, 'PROXY_ADD_BULK', { count: n, invalid });
    await ctx.reply(
      `\u2705 Added/updated <b>${n}</b> proxy(ies).` +
        (invalid > 0 ? ` \u26a0\ufe0f ${invalid} invalid line(s) skipped.` : '') +
        `\n\nRun <code>/check_proxy</code> to health-check &amp; verify exit IPs.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Single mode: url [label]
  const parts = rest.split(/\s+/);
  const url = parts[0]!;
  const label = parts.slice(1).join(' ') || undefined;
  if (!isValidProxyUrl(url)) {
    await ctx.reply('\u274c Invalid proxy URL. Use http(s)://user:pass@host:port or socks5://host:port', {
      parse_mode: 'HTML',
    });
    return;
  }
  addProxy(url, label, telegramId);
  clearAgentCache();
  logAction(telegramId, 'PROXY_ADD', { url: maskProxy(url), label });
  logger.info(`[PROXY] Added ${maskProxy(url)} by ${telegramId}`);
  await ctx.reply(
    `\u2705 Proxy added:\n<code>${maskProxy(url)}</code>\n\nRun <code>/check_proxy</code> to verify.`,
    { parse_mode: 'HTML' }
  );
}

/** /proxies — list pool with health + rotation status. */
export async function listProxyCommand(ctx: Context): Promise<void> {
  const proxies = getProxies();
  const active = proxyPoolActive();
  const header =
    `<b>Proxy Pool</b> \u2014 rotation ${config.proxy.enabled ? 'ON' : 'OFF'}, ` +
    `${active ? 'ACTIVE' : 'inactive (empty/off)'}\n\n`;

  if (proxies.length === 0) {
    await ctx.reply(
      header +
        'No proxies. OpenSea calls go direct from the server IP.\n\n' +
        'Add with <code>/add_proxy &lt;url&gt;</code> (or paste many, one per line).',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const lines = proxies.map((p, i) => {
    const health = p.last_ok === 1 ? `${p.last_latency_ms}ms` : p.last_ok === 0 ? '\u274c dead' : 'untested';
    const state = p.enabled ? '' : ' <i>(disabled)</i>';
    const name = p.label ? ` — ${esc(p.label)}` : '';
    return `${i + 1}. <code>${maskProxy(p.url)}</code>${name}\n    ${health}${state}`;
  });

  await ctx.reply(
    header + lines.join('\n') + `\n\n<code>/check_proxy</code> verify \u00b7 <code>/del_proxy &lt;url|#&gt;</code> \u00b7 <code>/clear_proxies</code>`,
    { parse_mode: 'HTML' }
  );
}

/** /check_proxy — health-check all proxies, verify distinct exit IPs, re-rank. */
export async function checkProxyCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const count = getProxyCount();
  if (count === 0) {
    await ctx.reply('No proxies to check. Add with <code>/add_proxy &lt;url&gt;</code>.', { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(`\u23f1\ufe0f Health-checking ${count} proxy(ies) (verifying exit IPs)...`, { parse_mode: 'HTML' });

  const results = await checkAllProxies();
  logAction(telegramId, 'PROXY_CHECK', { results: results.map((r) => ({ ok: r.latencyMs !== null, ip: r.exitIp })) });

  const alive = results.filter((r) => r.latencyMs !== null);
  const uniqueIps = new Set(alive.map((r) => r.exitIp).filter(Boolean));

  const lines = results.map((r, i) => {
    const status = r.latencyMs === null ? '\u274c dead' : `${r.latencyMs}ms \u00b7 IP ${esc(r.exitIp ?? '?')}`;
    const medal = r.latencyMs === null ? '\u2022' : i === 0 ? '\ud83e\udd47' : `${i + 1}.`;
    return `${medal} <code>${maskProxy(r.url)}</code>\n    ${status}`;
  });

  const summary =
    `\n\n\u2705 Alive: <b>${alive.length}/${results.length}</b> \u00b7 unique IPs: <b>${uniqueIps.size}</b>` +
    (uniqueIps.size < alive.length ? `\n\u26a0\ufe0f Some proxies share an exit IP \u2014 less effective vs 429.` : '');

  await ctx.reply(`<b>Proxy Health</b>\n\n${lines.join('\n')}${summary}`, { parse_mode: 'HTML' });
}

/** /del_proxy <url|#> — remove one proxy. */
export async function delProxyCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const arg = text.trim().split(/\s+/)[1];
  if (!arg) {
    await ctx.reply('Usage: <code>/del_proxy &lt;url&gt;</code> (or list number from /proxies)', { parse_mode: 'HTML' });
    return;
  }
  let target = arg;
  const idx = Number(arg);
  if (Number.isInteger(idx) && idx >= 1) {
    const proxies = getProxies();
    const picked = proxies[idx - 1];
    if (picked) target = picked.url;
  }
  const removed = removeProxy(target);
  clearAgentCache();
  if (!removed) {
    await ctx.reply('\u274c No matching proxy found.', { parse_mode: 'HTML' });
    return;
  }
  logAction(telegramId, 'PROXY_DEL', { target: maskProxy(target) });
  await ctx.reply('\u2705 Proxy removed.', { parse_mode: 'HTML' });
}

/** /clear_proxies — wipe the whole pool. */
export async function clearProxiesCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const n = clearProxies();
  clearAgentCache();
  logAction(telegramId, 'PROXY_CLEAR', { count: n });
  await ctx.reply(`\u2705 Cleared <b>${n}</b> proxy(ies). OpenSea calls now go direct.`, { parse_mode: 'HTML' });
}

/** /toggle_proxy <url> — enable/disable one proxy. */
export async function toggleProxyCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const arg = text.trim().split(/\s+/)[1];
  if (!arg) {
    await ctx.reply('Usage: <code>/toggle_proxy &lt;url&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const proxies = getProxies();
  const match = proxies.find((p) => p.url === arg);
  if (!match) {
    await ctx.reply('\u274c Proxy not found. See <code>/proxies</code>.', { parse_mode: 'HTML' });
    return;
  }
  const next = !match.enabled;
  setProxyEnabled(arg, next);
  clearAgentCache();
  logAction(telegramId, 'PROXY_TOGGLE', { url: maskProxy(arg), enabled: next });
  await ctx.reply(`\u2705 Proxy ${next ? 'enabled' : 'disabled'}.`, { parse_mode: 'HTML' });
}
