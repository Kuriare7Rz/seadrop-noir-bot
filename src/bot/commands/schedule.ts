import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateUser } from '../../db/users';
import { createScheduledMint, getUserScheduledMints, cancelScheduledMint } from '../../db/scheduledMints';
import { parseOpenSeaUrl } from '../../mint/urlParser';
import { checkIfDrop } from '../../mint/dropDetector';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { logAction } from '../../db/auditLogs';

/**
 * Parse time input as WIB (UTC+7).
 * Supports "22:00", "22:00:02", "10:00 PM", "10:00:02 PM", full date / ISO.
 */
function parseScheduledTime(timeStr: string): Date | null {
  try {
    const now = new Date();

    const buildWibTime = (hour: number, minute: number, second = 0): Date | null => {
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
        return null;
      }

      const scheduled = new Date(now);
      // Convert requested WIB clock time to UTC. Date object stays absolute UTC internally.
      scheduled.setUTCHours(hour - 7, minute, second, 0);

      if (scheduled <= now) {
        scheduled.setUTCDate(scheduled.getUTCDate() + 1);
      }

      return scheduled;
    };

    // Format: HH:MM or HH:MM:SS (24-hour, WIB)
    const time24Match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (time24Match && time24Match[1] && time24Match[2]) {
      return buildWibTime(
        parseInt(time24Match[1], 10),
        parseInt(time24Match[2], 10),
        time24Match[3] ? parseInt(time24Match[3], 10) : 0
      );
    }

    // Format: HH:MM or HH:MM:SS AM/PM (WIB)
    const time12Match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (time12Match && time12Match[1] && time12Match[2] && time12Match[4]) {
      let hour = parseInt(time12Match[1], 10);
      const minute = parseInt(time12Match[2], 10);
      const second = time12Match[3] ? parseInt(time12Match[3], 10) : 0;
      const period = time12Match[4];

      if (hour < 1 || hour > 12) return null;
      if (period.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (period.toUpperCase() === 'AM' && hour === 12) hour = 0;

      return buildWibTime(hour, minute, second);
    }

    // Format: YYYY-MM-DD HH:MM[:SS] or ISO string
    const fullDate = new Date(timeStr);
    if (!isNaN(fullDate.getTime())) return fullDate;

    return null;
  } catch {
    return null;
  }
}

/**
 * Build an informational note about the drop's stages for the user's chosen
 * time. IMPORTANT: this NEVER shifts the schedule. OpenSea's /mint endpoint
 * auto-selects whatever stage the wallet is eligible for at execution time
 * (WL / presale / public), so the bot must respect the exact time the user
 * picked — that is how you target a WL phase. The note just tells the user
 * which stage (if any) their time lands in, so they can catch obvious misses.
 */
async function alignToPublicStage(
  url: string,
  requested: Date
): Promise<{ time: Date; note: string | null }> {
  // Time is always kept as requested. Only produce an advisory note.
  if (!config.mint.scheduleAutoAlign) return { time: requested, note: null };
  try {
    const parsed = parseOpenSeaUrl(url);
    const slug = parsed.type === 'slug' ? parsed.slug : undefined;
    if (!slug) return { time: requested, note: null };

    const drop = await checkIfDrop(slug);
    if (!drop || !drop.stages || drop.stages.length === 0) return { time: requested, note: null };

    const t = requested.getTime();
    const fmt = (iso: string) => {
      const d = new Date(iso);
      return isNaN(d.getTime())
        ? iso
        : d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }) + ' WIB';
    };

    // Which stage window does the chosen time fall in?
    const matched = drop.stages.find((s) => {
      const start = Date.parse(s.start_time);
      const end = s.end_time ? Date.parse(s.end_time) : NaN;
      if (Number.isNaN(start)) return false;
      if (t < start) return false;
      if (!Number.isNaN(end) && t >= end) return false;
      return true;
    });

    const stageLines = drop.stages
      .slice()
      .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
      .map((s) => {
        const tag = matched && s.uuid === matched.uuid ? '✅ ' : '• ';
        return `${tag}<b>${s.label || s.stage_type}</b> — ${fmt(s.start_time)}`;
      })
      .join('\n');

    if (matched) {
      return {
        time: requested,
        note:
          `🎯 <b>Target stage:</b> ${matched.label || matched.stage_type}\n` +
          `<i>OpenSea auto-selects the stage your wallet is eligible for at this time.</i>\n\n` +
          `<b>Stages:</b>\n${stageLines}`,
      };
    }

    // Chosen time is outside every stage window — warn but do NOT move it.
    return {
      time: requested,
      note:
        `⚠️ <b>Heads up:</b> your time doesn't fall inside any mint stage window.\n` +
        `The mint may hit "not eligible / inactive". Double-check the time.\n\n` +
        `<b>Stages:</b>\n${stageLines}`,
    };
  } catch (err) {
    logger.warn(`[SCHEDULE] stage info lookup failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { time: requested, note: null };
  }
}

/**
 * /schedule_mint <url> <time> [wallet_from] [wallet_to]
 */
export async function scheduleMintCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const username = ctx.from?.username;
  getOrCreateUser(telegramId, username);

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  logger.info("[DEBUG scheduleMintCommand] text:", text);
  logger.info("[DEBUG scheduleMintCommand] parts:", JSON.stringify(parts));
  logger.info("[DEBUG scheduleMintCommand] parts.length:", parts.length);

  if (parts.length < 3) {
    await ctx.reply(
      '❌ <b>Usage:</b> /schedule_mint &lt;opensea_url&gt; &lt;time&gt; [wallet_from] [wallet_to]\n\n' +
      '<b>Time formats:</b>\n' +
      '• 22:00 or 22:00:02 (24-hour, WIB)\n' +
      '• 10:00 PM or 10:00:02 PM (12-hour, WIB)\n' +
      '• 2024-06-13 22:00:02 (full date)\n\n' +
      '<b>Examples:</b>\n' +
      '• /schedule_mint https://opensea.io/collection/azuki 22:00\n' +
      '• /schedule_mint https://opensea.io/collection/azuki 10:00 PM 1 5\n' +
      '• /schedule_mint https://opensea.io/collection/azuki "2024-06-13 22:00"',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const url = parts[1];
  const timeStr = parts[2];
  const walletFrom = parts[3] ? parseInt(parts[3], 10) : undefined;
  const walletTo = parts[4] ? parseInt(parts[4], 10) : undefined;

  // Validate URL
  if (!url) {
    await ctx.reply('❌ <b>Missing URL parameter</b>', { parse_mode: 'HTML' });
    return;
  }

  try {
    parseOpenSeaUrl(url);
  } catch (err) {
    await ctx.reply(
      `❌ <b>Invalid URL:</b> ${err instanceof Error ? err.message : 'Unknown error'}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Parse time
  if (!timeStr) {
    await ctx.reply('❌ <b>Missing time parameter</b>', { parse_mode: 'HTML' });
    return;
  }

  const scheduledTime = parseScheduledTime(timeStr);
  if (!scheduledTime) {
    await ctx.reply(
      '❌ <b>Invalid time format.</b>\n\n' +
      'Supported formats:\n' +
      '• 22:00 or 22:00:02 (24-hour, WIB)\n' +
      '• 10:00 PM or 10:00:02 PM (12-hour, WIB)\n' +
      '• 2024-06-13 22:00',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Check if time is in the future
  if (scheduledTime <= new Date()) {
    await ctx.reply('❌ <b>Scheduled time must be in the future</b>', { parse_mode: 'HTML' });
    return;
  }

  // Auto-align to the drop's public stage if the requested time is too early
  const aligned = await alignToPublicStage(url, scheduledTime);
  const mintTime = aligned.time;

  // Validate wallet range if provided
  if (walletFrom !== undefined) {
    if (isNaN(walletFrom) || walletFrom < 1) {
      await ctx.reply('❌ <b>Invalid wallet_from. Must be ≥ 1</b>', { parse_mode: 'HTML' });
      return;
    }

    if (walletTo !== undefined && (isNaN(walletTo) || walletTo < walletFrom)) {
      await ctx.reply('❌ <b>Invalid wallet_to. Must be ≥ wallet_from</b>', { parse_mode: 'HTML' });
      return;
    }
  }

  const scheduleId = uuidv4();

  try {
    createScheduledMint({
      id: scheduleId,
      telegram_id: telegramId,
      url: url, // Already validated as non-undefined above
      scheduled_time: mintTime.toISOString(),
      wallet_from: walletFrom,
      wallet_to: walletTo,
    });

    logAction(telegramId, 'SCHEDULE_MINT_CREATED', { scheduleId, url, scheduledTime: mintTime.toISOString() });

    const walletInfo = walletFrom
      ? walletTo
        ? ` (wallets ${walletFrom}-${walletTo})`
        : ` (wallet ${walletFrom})`
      : '';

    await ctx.reply(
      `✅ <b>Mint scheduled!</b>\n\n` +
      (aligned.note ? aligned.note + `\n\n` : '') +
      `⏰ Time: ${mintTime.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }) + ' WIB'}\n` +
      `🌐 UTC: ${mintTime.toISOString()}\n` +
      `🔗 URL: ${url}\n` +
      `${walletInfo}\n\n` +
      `ID: <code>${scheduleId}</code>\n\n` +
      `Use /list_schedules to see all scheduled mints\n` +
      `Use /cancel_schedule &lt;id&gt; to cancel`,
      { parse_mode: 'HTML' }
    );

    logger.info(`[SCHEDULE] User ${telegramId} scheduled mint ${scheduleId} for ${mintTime.toISOString()}`);
  } catch (error) {
    logger.error(`[SCHEDULE] Failed to create scheduled mint: ${error instanceof Error ? error.message : 'unknown'}`);
    await ctx.reply('❌ <b>Failed to schedule mint. Please try again.</b>', { parse_mode: 'HTML' });
  }
}

/**
 * /list_schedules
 */
export async function listSchedulesCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  getOrCreateUser(telegramId);

  try {
    const schedules = getUserScheduledMints(telegramId);

    if (schedules.length === 0) {
      await ctx.reply('📭 <b>No scheduled mints</b>\n\nUse /schedule_mint to schedule one.', { parse_mode: 'HTML' });
      return;
    }

    const lines: string[] = ['📅 <b>Your Scheduled Mints</b>\n'];

    for (const schedule of schedules) {
      const scheduledTime = new Date(schedule.scheduled_time);
      const status = schedule.status === 'PENDING' ? '⏳ Pending' :
                     schedule.status === 'EXECUTED' ? '✅ Executed' :
                     schedule.status === 'CANCELLED' ? '❌ Cancelled' :
                     '⚠️ Failed';

      const walletInfo = schedule.wallet_from
        ? schedule.wallet_to
          ? ` | Wallets ${schedule.wallet_from}-${schedule.wallet_to}`
          : ` | Wallet ${schedule.wallet_from}`
        : '';

      lines.push(
        `${status}\n` +
        `⏰ ${scheduledTime.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }) + ' WIB'}\n` +
        `🔗 ${schedule.url.slice(0, 50)}...\n` +
        `ID: <code>${schedule.id}</code>${walletInfo}\n`
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    logger.error(`[SCHEDULE] Failed to list schedules: ${error instanceof Error ? error.message : 'unknown'}`);
    await ctx.reply('❌ <b>Failed to fetch schedules</b>', { parse_mode: 'HTML' });
  }
}

/**
 * /cancel_schedule <id>
 */
export async function cancelScheduleCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  getOrCreateUser(telegramId);

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply(
      '❌ <b>Usage:</b> /cancel_schedule &lt;schedule_id&gt;\n\n' +
      'Get the schedule ID from /list_schedules',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const scheduleId = parts[1];

  if (!scheduleId) {
    await ctx.reply('❌ <b>Missing schedule ID</b>', { parse_mode: 'HTML' });
    return;
  }

  try {
    const success = cancelScheduledMint(scheduleId);

    if (success) {
      logAction(telegramId, 'SCHEDULE_MINT_CANCELLED', { scheduleId });
      await ctx.reply(`✅ <b>Schedule cancelled</b>\n\nID: <code>${scheduleId}</code>`, { parse_mode: 'HTML' });
      logger.info(`[SCHEDULE] User ${telegramId} cancelled schedule ${scheduleId}`);
    } else {
      await ctx.reply(
        '❌ <b>Could not cancel schedule</b>\n\n' +
        'Schedule not found, already executed, or already cancelled.',
        { parse_mode: 'HTML' }
      );
    }
  } catch (error) {
    logger.error(`[SCHEDULE] Failed to cancel schedule: ${error instanceof Error ? error.message : 'unknown'}`);
    await ctx.reply('❌ <b>Failed to cancel schedule</b>', { parse_mode: 'HTML' });
  }
}


export async function cancelScheduleCallback(ctx: Context, scheduleId: string): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  getOrCreateUser(telegramId);
  const success = cancelScheduledMint(scheduleId);
  if ('answerCbQuery' in ctx) await ctx.answerCbQuery(success ? 'Schedule cancelled' : 'Could not cancel');
  if (success) {
    logAction(telegramId, 'SCHEDULE_MINT_CANCELLED_BUTTON', { scheduleId });
    await ctx.reply(`✅ <b>Schedule cancelled</b>\n\nID: <code>${scheduleId}</code>`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ <b>Could not cancel schedule</b> — not found, executed, or already cancelled.', { parse_mode: 'HTML' });
  }
}

/**
 * /schedule_mint_max <url> <time> [wallet_from] [wallet_to]
 * Schedule a mint job with max quantity at specified time (WIB)
 */
export async function scheduleMintMaxCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const username = ctx.from?.username;
  getOrCreateUser(telegramId, username);

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);

  if (parts.length < 3) {
    await ctx.reply(
      '❌ <b>Usage:</b> /schedule_mint_max &lt;opensea_url&gt; &lt;time&gt; [wallet_from] [wallet_to]\n\n' +
      '<b>Time formats (WIB):</b>\n' +
      '• 22:00 or 22:00:02 (24-hour, WIB)\n' +
      '• 10:00 PM or 10:00:02 PM (12-hour, WIB)\n\n' +
      '<b>Examples:</b>\n' +
      '• /schedule_mint_max https://opensea.io/collection/azuki 22:00\n' +
      '• /schedule_mint_max https://opensea.io/collection/azuki 10:00 PM 1 5',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const url = parts[1];
  const timeStr = parts[2];
  const walletFrom = parts[3] ? parseInt(parts[3], 10) : undefined;
  const walletTo = parts[4] ? parseInt(parts[4], 10) : undefined;

  if (!url) {
    await ctx.reply('❌ <b>Missing URL parameter</b>', { parse_mode: 'HTML' });
    return;
  }

  try {
    parseOpenSeaUrl(url);
  } catch (err) {
    await ctx.reply(
      `❌ <b>Invalid URL:</b> ${err instanceof Error ? err.message : 'Unknown error'}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!timeStr) {
    await ctx.reply('❌ <b>Missing time parameter</b>', { parse_mode: 'HTML' });
    return;
  }

  const scheduledTime = parseScheduledTime(timeStr);
  if (!scheduledTime) {
    await ctx.reply(
      '❌ <b>Invalid time format.</b>\n\n' +
      'Supported formats (WIB):\n' +
      '• 22:00 or 22:00:02 (24-hour, WIB)\n' +
      '• 10:00 PM or 10:00:02 PM (12-hour, WIB)',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (scheduledTime <= new Date()) {
    await ctx.reply('❌ <b>Scheduled time must be in the future</b>', { parse_mode: 'HTML' });
    return;
  }

  const aligned = await alignToPublicStage(url, scheduledTime);
  const mintTime = aligned.time;

  if (walletFrom !== undefined) {
    if (isNaN(walletFrom) || walletFrom < 1) {
      await ctx.reply('❌ <b>Invalid wallet_from. Must be ≥ 1</b>', { parse_mode: 'HTML' });
      return;
    }

    if (walletTo !== undefined && (isNaN(walletTo) || walletTo < walletFrom)) {
      await ctx.reply('❌ <b>Invalid wallet_to. Must be ≥ wallet_from</b>', { parse_mode: 'HTML' });
      return;
    }
  }

  const scheduleId = uuidv4();

  try {
    createScheduledMint({
      id: scheduleId,
      telegram_id: telegramId,
      url: url,
      scheduled_time: mintTime.toISOString(),
      wallet_from: walletFrom,
      wallet_to: walletTo,
      force_max_quantity: 1, // MAX quantity flag
    });

    logAction(telegramId, 'SCHEDULE_MINT_MAX_CREATED', { scheduleId, url, scheduledTime: mintTime.toISOString() });

    const walletInfo = walletFrom
      ? walletTo
        ? ` (wallets ${walletFrom}-${walletTo})`
        : ` (wallet ${walletFrom})`
      : '';

    await ctx.reply(
      `✅ <b>Scheduled MAX quantity mint</b>\n\n` +
      (aligned.note ? aligned.note + `\n\n` : '') +
      `🆔 Job ID: <code>${scheduleId}</code>\n` +
      `🔗 URL: ${url}\n` +
      `⏰ Time: ${mintTime.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB${walletInfo}\n` +
      `🌐 UTC: ${mintTime.toISOString()}\n` +
      `📊 Quantity: <b>MAX</b>\n\n` +
      `Use /list_schedules to view all scheduled mints.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply(
      `❌ <b>Failed to schedule mint:</b> ${err instanceof Error ? err.message : 'Unknown error'}`,
      { parse_mode: 'HTML' }
    );
  }
}
