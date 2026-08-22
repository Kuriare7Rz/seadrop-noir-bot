import { config } from '../../config';
import type { Context, MiddlewareFn } from 'telegraf';

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

/**
 * Single-operator hard gate.
 *
 * This bot controls funded burner wallets, so every command should run only
 * from the configured Telegram admin in a private DM. Group/supergroup/channel
 * execution is blocked even if the admin is present, to avoid accidental mints
 * from forwarded/shared commands.
 */
export function adminOnly(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const telegramId = ctx.from?.id?.toString();
    if (telegramId !== config.telegram.adminTelegramId || !isPrivateChat(ctx)) {
      await ctx.reply('⛔ Unauthorized. This bot only accepts private DM commands from the configured admin.');
      return;
    }
    return next();
  };
}
