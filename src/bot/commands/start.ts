import type { Context } from 'telegraf';
import { walletPool } from '../../wallet/pool';
import { getOrCreateUser } from '../../db/users';
import { config } from '../../config';

export async function startCommand(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id?.toString() ?? '';
  const username = ctx.from?.username;
  getOrCreateUser(telegramId, username);

  const poolStatus = walletPool.getPoolStatus();
  const idle = poolStatus.filter((w) => w.status === 'IDLE').length;
  const busy = poolStatus.filter((w) => w.status === 'BUSY').length;
  const total = poolStatus.length;

  await ctx.reply(
    `\ud83e\udd16 <b>SeaDrop Mint Bot</b>\n\n` +
    `Automated NFT minting bot for OpenSea SeaDrop collections.\n` +
    `Active chain: <b>${config.chain.label}</b> (id ${config.chain.chainId}).\n\n` +
    `<b>\ud83d\udcb0 Wallet Pool</b>\n` +
    `Total: ${total} | Idle: ${idle} | Busy: ${busy}\n\n` +
    `<b>\ud83d\udee0 Quick Commands</b>\n` +
    `/mint &lt;opensea_url&gt; \u2014 Start a mint job\n` +
    `/mint_max &lt;opensea_url&gt; \u2014 Mint max quantity\n` +
    `/wallets \u2014 View wallet pool\n` +
    `/wl &lt;opensea_url&gt; \u2014 Check WL eligibility for all wallets\n` +
    `/settings \u2014 View your settings\n` +
    `/help \u2014 All commands\n\n` +
    `<i>\u26a0\ufe0f Use burner wallets only. Never use wallets with significant funds.</i>`,
    { parse_mode: 'HTML' }
  );
}

export async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>\ud83d\udcd6 SeaDrop Mint Bot \u2014 Commands</b>\n\n` +
    `<b>\ud83c\udfaf Minting</b>\n` +
    `/mint &lt;url&gt; \u2014 Mint now from an OpenSea collection URL\n` +
    `/mint_max &lt;url&gt; \u2014 Mint the max quantity the stage allows\n` +
    `/dryrun &lt;url&gt; \u2014 Simulate a mint, no tx sent (test eligibility)\n` +
    `/status \u2014 Active mint jobs right now\n` +
    `/history \u2014 Last 20 mint transactions\n` +
    `/cancel &lt;job_id&gt; \u2014 Cancel a pending job\n` +
    `/wl &lt;url | slug | contract&gt; \u2014 Whitelist eligibility for all pool wallets (OpenSea + SeaDrop)\n\n` +
    `<b>\u23f0 Scheduled / Snipe</b>\n` +
    `/schedule_mint &lt;url&gt; &lt;time&gt; [from] [to] \u2014 Schedule a mint at a WIB time\n` +
    `/schedule_mint_max &lt;url&gt; &lt;time&gt; [from] [to] \u2014 Same, but max quantity\n` +
    `<i>   \u2022 [from] [to] = wallet range. All 67 wallets: </i><code>1 67</code>\n` +
    `<i>   \u2022 Auto-snipe: pre-arms then hammers /mint the instant the window opens</i>\n` +
    `/list_schedules \u2014 View all scheduled mints\n` +
    `/cancel_schedule &lt;id&gt; \u2014 Cancel a scheduled mint\n\n` +
    `<b>\ud83d\udd11 OpenSea API Key</b>\n` +
    `/api \u2014 Show active key + source (.env or override)\n` +
    `/api status \u2014 Show key + live auth probe\n` +
    `/api test [slug] \u2014 Verify effective key against the Drops API\n` +
    `/api set &lt;key&gt; \u2014 Set + validate + hot-apply a new key <i>(admin)</i>\n` +
    `/api reset \u2014 Drop override, fall back to .env <i>(admin)</i>\n` +
    `<i>   \u2022 Dead key = stages/target unreadable \u2192 "Mint has not started". Fix with /api set.</i>\n` +
    `<i>   \u2022 Free key: POST api.opensea.io/api/v2/auth/keys (max 2/day, expires 7d)</i>\n\n` +
    `<b>\ud83c\udf10 RPC (speed + fallback)</b>\n` +
    `/rpcs \u2014 List RPCs for the active chain, fastest-first\n` +
    `/check_rpc \u2014 Benchmark all RPCs + re-rank (run before a big mint)\n` +
    `/add_rpc &lt;url&gt; [label] \u2014 Add an RPC <i>(admin)</i>\n` +
    `/del_rpc &lt;url|#&gt; \u2014 Remove an RPC <i>(admin)</i>\n` +
    `/toggle_rpc &lt;url&gt; \u2014 Enable/disable without deleting <i>(admin)</i>\n` +
    `<i>   \u2022 2+ RPCs \u2192 tx blasted to all at once, fastest landing wins</i>\n\n` +
    `<b>\ud83d\udd12 Proxy (bypass OpenSea 429)</b>\n` +
    `/proxies \u2014 List proxy pool + health\n` +
    `/check_proxy \u2014 Test proxies, verify each has a distinct exit IP\n` +
    `/add_proxy &lt;url&gt; [label] \u2014 Add one, or paste many (1 per line) <i>(admin)</i>\n` +
    `/del_proxy &lt;url|#&gt; \u2014 Remove one proxy <i>(admin)</i>\n` +
    `/clear_proxies \u2014 Wipe the whole pool <i>(admin)</i>\n` +
    `/toggle_proxy &lt;url&gt; \u2014 Enable/disable one proxy <i>(admin)</i>\n` +
    `<i>   \u2022 Pool filled \u2192 each wallet hits OpenSea from a different IP</i>\n\n` +
    `<b>\ud83d\udcb0 Wallets</b>\n` +
    `/wallets \u2014 Wallet pool status (idle/busy/balance)\n` +
    `/add_wallet &lt;key&gt; \u2014 Add a wallet at runtime <i>(admin)</i>\n\n` +
    `<b>\u2699\ufe0f Settings</b>\n` +
    `/settings \u2014 Show your current settings\n` +
    `/set_maxprice &lt;eth&gt; \u2014 Max mint price cap (e.g. 0.05)\n` +
    `/set_maxgas &lt;eth&gt; \u2014 Max gas fee cap (e.g. 0.01)\n` +
    `/set_quantity &lt;n&gt; \u2014 Quantity per wallet\n` +
    `/set_priorityfee &lt;gwei&gt; \u2014 Priority fee override\n\n` +
    `<b>\ud83d\udee1 Ops</b>\n` +
    `/preflight &lt;url&gt; \u2014 Full pre-mint check (eligibility, price, balance)\n` +
    `/status_plus \u2014 Detailed bot + pool + chain status\n` +
    `/chain \u2014 Show the active chain\n` +
    `/panic \u2014 Emergency stop all pending jobs\n\n` +
    `<b>\ud83d\udd11 Admin</b>\n` +
    `/admin_stats \u2014 Total mints, success rate, gas spent\n` +
    `/admin_reload \u2014 Reload wallet pool from .env\n` +
    `/admin_blacklist \u2014 Show full blacklist\n` +
    `/blacklist &lt;contract&gt; \u2014 Block a contract\n` +
    `/whitelist &lt;contract&gt; \u2014 Unblock a contract\n\n` +
    `<i>\u26a0\ufe0f Burner wallets only. Times are WIB. Add RPCs + proxies once; every scheduled mint uses them automatically.</i>`,
    { parse_mode: 'HTML' }
  );
}
