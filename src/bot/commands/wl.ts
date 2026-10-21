import type { Context } from 'telegraf';
import { formatEther } from 'viem';
import { checkWhitelist, type WlReport } from '../../whitelist/check';
import { walletPool } from '../../wallet/pool';
import type { WalletRange } from '../../mint/engine';

/**
 * /wl <opensea_url | slug | contract> — whitelist eligibility check for
 * every wallet in the pool, before committing to a mint.
 *
 * Note: `/whitelist` stays the admin contract-allowlist command; this NFT
 * eligibility checker takes the short `/wl` name the NFT side already uses
 * everywhere else. Two sources per wallet:
 *  - OpenSea (SIWE + DropEligibilityQuery): authoritative for gated stages
 *  - SeaDrop on-chain: public stage, per-wallet mints, supply, WL root
 */

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Parse optional wallet range arguments: /wl <input> [from] [to].
 * Same semantics as parseWalletRange in mint.ts — 1-based, a lone [from]
 * means that single wallet, [to] is clamped to the pool size.
 */
function parseWlRange(
  parts: string[]
): { range: WalletRange | undefined; error: string | undefined } {
  const fromStr = parts[2];
  const toStr = parts[3];

  if (!fromStr) return { range: undefined, error: undefined };

  const from = parseInt(fromStr, 10);
  const to = toStr !== undefined ? parseInt(toStr, 10) : from;

  if (isNaN(from) || from < 1) {
    return {
      range: undefined,
      error: `Invalid wallet range start: <b>${fromStr}</b>. Must be a positive number.`,
    };
  }
  if (isNaN(to) || to < from) {
    return {
      range: undefined,
      error: `Invalid wallet range end: <b>${toStr}</b>. Must be ≥ start (${from}).`,
    };
  }

  const totalWallets = walletPool.getWalletCount();
  if (from > totalWallets) {
    return {
      range: undefined,
      error: `Wallet range start <b>${from}</b> exceeds total wallets in pool (<b>${totalWallets}</b>).`,
    };
  }

  return { range: { from, to: Math.min(to, totalWallets) }, error: undefined };
}

function formatReport(report: WlReport): string {
  const title = report.slug ?? report.contract ?? report.input;
  const rangeNote = report.range
    ? ` · wallets ${report.range.from}–${report.range.to}`
    : '';
  const lines: string[] = [
    `🎟 <b>WL Check — ${title}</b> (${report.chainLabel}${rangeNote})`,
  ];
  if (report.contract) lines.push(`Contract: <code>${report.contract}</code>`);
  lines.push('');

  for (const r of report.results) {
    lines.push(
      `<b>Wallet ${r.index}</b> <code>${shortAddress(r.address)}</code>`
    );

    if (r.opensea) {
      const icon =
        r.opensea.status === 'eligible'
          ? '✅'
          : r.opensea.status === 'not'
            ? '❌'
            : '⏳';
      lines.push(`   OpenSea: ${icon} ${r.opensea.detail}`);
    } else if (r.openseaSkipped) {
      lines.push(`   OpenSea: ⏳ ${r.openseaSkipped}`);
    }

    if (r.seadrop) {
      const sd = r.seadrop;
      const parts: string[] = [];
      parts.push(
        sd.publicOpen
          ? `public OPEN${
              sd.publicDrop ? ` @ ${formatEther(sd.publicDrop.mintPrice)} ETH` : ''
            }`
          : 'public not open'
      );
      if (sd.publicDrop && sd.publicDrop.maxTotalMintableByWallet > 0) {
        parts.push(`cap ${sd.publicDrop.maxTotalMintableByWallet}/wallet`);
      }
      parts.push(`minted ${sd.mintedByWallet.toString()}`);
      if (sd.maxSupply > 0n) {
        parts.push(`supply ${sd.currentSupply.toString()}/${sd.maxSupply.toString()}`);
      }
      if (sd.soldOut) parts.push('SOLD OUT');
      parts.push(sd.hasAllowlistRoot ? 'WL root set' : 'no WL root');
      lines.push(`   SeaDrop: ${parts.join(' · ')}`);
    } else if (r.seadropError) {
      lines.push(`   SeaDrop: ⚠️ ${r.seadropError}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export async function wlCommand(ctx: Context): Promise<void> {
  const text =
    ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const input = parts[1];

  if (!input) {
    await ctx.reply(
      '🎟 <b>Usage:</b> /wl &lt;opensea_url | slug | contract_address&gt; [from] [to]\n' +
        'Checks pool wallets against the drop: OpenSea gated eligibility ' +
        '(authoritative) + SeaDrop on-chain state. Optional [from] [to] limits ' +
        'the check to a wallet range, e.g. /wl &lt;url&gt; 5 12.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { range, error } = parseWlRange(parts);
  if (error) {
    await ctx.reply(`❌ ${error}`, { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(
    range
      ? `🎟 Checking WL eligibility for wallets ${range.from}–${range.to}…`
      : '🎟 Checking WL eligibility for all pool wallets…'
  );
  try {
    const report = await checkWhitelist(input, range);
    await ctx.reply(formatReport(report), { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(
      `❌ WL check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      { parse_mode: 'HTML' }
    );
  }
}
