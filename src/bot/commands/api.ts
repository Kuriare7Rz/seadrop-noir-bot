import type { Context } from 'telegraf';
import { logAction } from '../../db/auditLogs';
import { deleteAppSetting } from '../../db/appSettings';
import { logger } from '../../utils/logger';
import {
  OPENSEA_KEY_SETTING,
  getOpenSeaKeyMeta,
  persistOpenSeaApiKey,
  verifyOpenSeaKey,
} from '../../mint/openseaAuth';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * /api — manage the OpenSea API key at runtime (DB override wins over .env).
 * Subcommands:
 *   /api            → show current key source + status
 *   /api status     → same as above, plus a live auth probe
 *   /api test [slug]→ live-verify the effective key against the Drops API
 *   /api set <key>  → set a new key (persisted, hot-applied, no redeploy)
 *   /api reset      → drop the override and fall back to the .env key
 */
export async function apiCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/).slice(1);
  const sub = (parts[0] ?? '').toLowerCase();

  // No subcommand → show status card.
  if (!sub || sub === 'status' || sub === 'info') {
    const meta = getOpenSeaKeyMeta();
    const changed =
      meta.updated_at && meta.updated_by
        ? `\nOverride set by <code>${esc(meta.updated_by)}</code> at ${esc(meta.updated_at)}`
        : '';
    let probeLine = '';
    if (sub === 'status') {
      const chk = await verifyOpenSeaKey();
      probeLine = chk.ok
        ? `\n\n\u2705 Live check: <b>OK</b> (HTTP ${chk.status})`
        : `\n\n\u274c Live check: <b>FAILED</b> (HTTP ${chk.status}) \u2014 ${esc(chk.detail)}`;
    }
    await ctx.reply(
      `<b>\ud83d\udd11 OpenSea API Key</b>\n\n` +
        `Source: <b>${meta.source === 'override' ? 'runtime override (DB)' : '.env'}</b>\n` +
        `Key: <code>${esc(meta.masked)}</code>${changed}${probeLine}\n\n` +
        `<i>/api set &lt;key&gt; \u00b7 /api test \u00b7 /api reset</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (sub === 'test') {
    const slug = parts[1];
    await ctx.reply('\u23f1\ufe0f Verifying OpenSea key against the Drops API...', { parse_mode: 'HTML' });
    const chk = await verifyOpenSeaKey(undefined, slug);
    logAction(telegramId, 'API_KEY_TEST', { status: chk.status, ok: chk.ok });
    await ctx.reply(
      chk.ok
        ? `\u2705 <b>Key valid</b> (HTTP ${chk.status})\n${esc(chk.detail)}`
        : `\u274c <b>Key check failed</b> (HTTP ${chk.status})\n${esc(chk.detail)}\n\nSet a new one: <code>/api set &lt;key&gt;</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (sub === 'set') {
    const key = parts[1];
    if (!key || key.length < 8) {
      await ctx.reply(
        'Usage: <code>/api set &lt;opensea_api_key&gt;</code>\nGet one at <code>https://docs.opensea.io</code> (Developer \u2192 API Keys).',
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Validate BEFORE persisting so we never store a dead key.
    await ctx.reply('\u23f1\ufe0f Validating new key...', { parse_mode: 'HTML' });
    const chk = await verifyOpenSeaKey(key);
    if (!chk.ok) {
      await ctx.reply(
        `\u274c New key rejected (HTTP ${chk.status}) \u2014 ${esc(chk.detail)}.\nNot saved. Double-check and retry.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    persistOpenSeaApiKey(key, telegramId);
    logAction(telegramId, 'API_KEY_SET', { status: chk.status });
    logger.info(`[API] OpenSea key updated by ${telegramId} (validated HTTP ${chk.status})`);

    // Best-effort: scrub the message that contains the raw key from chat.
    try {
      if (ctx.chat && ctx.message && 'message_id' in ctx.message) {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
      }
    } catch {
      /* deletion is best-effort; ignore if the bot lacks delete rights */
    }

    const meta = getOpenSeaKeyMeta();
    await ctx.reply(
      `\u2705 <b>OpenSea key updated &amp; validated</b> (HTTP ${chk.status}).\n` +
        `Now active: <code>${esc(meta.masked)}</code>\n` +
        `<i>Applied immediately \u2014 no restart needed. (Your key message was deleted for safety.)</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (sub === 'reset' || sub === 'clear' || sub === 'unset') {
    const removed = deleteAppSetting(OPENSEA_KEY_SETTING);
    logAction(telegramId, 'API_KEY_RESET', { removed });
    const meta = getOpenSeaKeyMeta();
    await ctx.reply(
      removed
        ? `\u2705 Override cleared. Falling back to .env key: <code>${esc(meta.masked)}</code>\n<i>Run /api test to verify it.</i>`
        : `\u2139\ufe0f No override was set. Using .env key: <code>${esc(meta.masked)}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.reply(
    `<b>\ud83d\udd11 /api \u2014 OpenSea key manager</b>\n\n` +
      `<code>/api</code> \u2014 show current key + source\n` +
      `<code>/api status</code> \u2014 show + live auth probe\n` +
      `<code>/api test [slug]</code> \u2014 live-verify effective key\n` +
      `<code>/api set &lt;key&gt;</code> \u2014 set + validate + hot-apply\n` +
      `<code>/api reset</code> \u2014 drop override, use .env\n`,
    { parse_mode: 'HTML' }
  );
}
