import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getOrCreateUser, getUserSettings, updateUserSettings } from '../../db/users';
import { config } from '../../config';
export type { UserSettings } from '../../db/users';

function getDefaults() {
  return {
    max_mint_price_eth: config.mint.defaultMaxMintPriceEth,
    max_gas_eth: config.mint.defaultMaxGasEth,
    quantity: config.mint.defaultQuantity,
    priority_fee_gwei: config.mint.maxPriorityFeeGwei,
  };
}

export async function settingsCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  getOrCreateUser(telegramId, ctx.from?.username);
  const settings = getUserSettings(telegramId, getDefaults());

  await ctx.reply(
    `<b>\u2699\ufe0f Your Settings</b>\n\n` +
    `Max Mint Price: <b>${settings.max_mint_price_eth} ETH</b>\n` +
    `Max Gas Fee: <b>${settings.max_gas_eth} ETH</b>\n` +
    `Quantity per Job: <b>${settings.quantity}</b>\n` +
    `Priority Fee: <b>${settings.priority_fee_gwei} gwei</b>\n\n` +
    `<i>Use buttons below or /set_maxprice, /set_maxgas, /set_quantity, /set_priorityfee.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Max Price 0.01', 'set:maxprice:0.01'), Markup.button.callback('0.05', 'set:maxprice:0.05'), Markup.button.callback('0.1', 'set:maxprice:0.1')],
        [Markup.button.callback('Max Gas 0.003', 'set:maxgas:0.003'), Markup.button.callback('0.005', 'set:maxgas:0.005'), Markup.button.callback('0.01', 'set:maxgas:0.01')],
        [Markup.button.callback('Qty 1', 'set:qty:1'), Markup.button.callback('Qty 2', 'set:qty:2'), Markup.button.callback('Qty 5', 'set:qty:5')],
        [Markup.button.callback('Priority 0.05', 'set:prio:0.05'), Markup.button.callback('0.2', 'set:prio:0.2'), Markup.button.callback('1 gwei', 'set:prio:1')],
      ]),
    }
  );
}

export async function setMaxPriceCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const value = parts[1];

  if (!value || isNaN(parseFloat(value)) || parseFloat(value) <= 0) {
    await ctx.reply('\u274c Usage: /set_maxprice &lt;eth&gt;\nExample: /set_maxprice 0.05', { parse_mode: 'HTML' });
    return;
  }

  getOrCreateUser(telegramId, ctx.from?.username);
  updateUserSettings(telegramId, { max_mint_price_eth: value }, getDefaults());
  await ctx.reply(`\u2705 Max mint price set to <b>${value} ETH</b>`, { parse_mode: 'HTML' });
}

export async function setMaxGasCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const value = parts[1];

  if (!value || isNaN(parseFloat(value)) || parseFloat(value) <= 0) {
    await ctx.reply('\u274c Usage: /set_maxgas &lt;eth&gt;\nExample: /set_maxgas 0.01', { parse_mode: 'HTML' });
    return;
  }

  getOrCreateUser(telegramId, ctx.from?.username);
  updateUserSettings(telegramId, { max_gas_eth: value }, getDefaults());
  await ctx.reply(`\u2705 Max gas fee set to <b>${value} ETH</b>`, { parse_mode: 'HTML' });
}

export async function setPriorityFeeCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const value = parts[1];
  const fee = parseFloat(value ?? '');

  if (!value || isNaN(fee) || fee < 0) {
    await ctx.reply(
      '\u274c Usage: /set_priorityfee &lt;gwei&gt;\n' +
      'Example: /set_priorityfee 0.1\n' +
      '(Min: 0, recommended: 0.1\u20132 gwei)',
      { parse_mode: 'HTML' }
    );
    return;
  }

  getOrCreateUser(telegramId, ctx.from?.username);
  updateUserSettings(telegramId, { priority_fee_gwei: fee }, getDefaults());
  await ctx.reply(`\u2705 Priority fee set to <b>${fee} gwei</b>`, { parse_mode: 'HTML' });
}

export async function setQuantityCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const value = parts[1];
  const qty = parseInt(value ?? '', 10);

  if (!value || isNaN(qty) || qty <= 0 || qty > 100) {
    await ctx.reply('\u274c Usage: /set_quantity &lt;n&gt;\nExample: /set_quantity 2\n(Min: 1, Max: 100)', { parse_mode: 'HTML' });
    return;
  }

  getOrCreateUser(telegramId, ctx.from?.username);
  updateUserSettings(telegramId, { quantity: qty }, getDefaults());
  await ctx.reply(`\u2705 Mint quantity set to <b>${qty}</b>`, { parse_mode: 'HTML' });
}


export async function settingsCallback(ctx: Context, kind: string, value: string): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  getOrCreateUser(telegramId, ctx.from?.username);
  const n = parseFloat(value);
  if (Number.isNaN(n) || n <= 0) {
    if ('answerCbQuery' in ctx) await ctx.answerCbQuery('Invalid value');
    return;
  }
  if (kind === 'maxprice') updateUserSettings(telegramId, { max_mint_price_eth: value }, getDefaults());
  else if (kind === 'maxgas') updateUserSettings(telegramId, { max_gas_eth: value }, getDefaults());
  else if (kind === 'qty') updateUserSettings(telegramId, { quantity: Math.floor(n) }, getDefaults());
  else if (kind === 'prio') updateUserSettings(telegramId, { priority_fee_gwei: n }, getDefaults());
  else {
    if ('answerCbQuery' in ctx) await ctx.answerCbQuery('Unknown setting');
    return;
  }
  if ('answerCbQuery' in ctx) await ctx.answerCbQuery('Setting updated');
  await ctx.reply(`✅ Updated <b>${kind}</b> to <b>${value}</b>`, { parse_mode: 'HTML' });
}
