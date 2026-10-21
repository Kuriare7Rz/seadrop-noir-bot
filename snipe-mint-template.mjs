#!/usr/bin/env node
/**
 * ============================================================================
 * SNIPE MINT TEMPLATE (pre-sign mode) — reusable for direct-contract mints
 * ============================================================================
 * NEXT MINT CHECKLIST — ganti ini aja:
 *   1. const MINT       = "0x..."            (contract address mint)
 *   2. const PRICE_PER  = parseEther("...")  (harga per token)
 *   3. const QTY_PER_TX = Nn                 (max per tx dari contract)
 *   4. const WALLET_KEYS = [2,3,4,5,6]       (WALLET_x_KEY di .env yg dipakai)
 *   5. Cek ABI: fn mint(qty)? cek nama fungsi + saleStartTime/saleOpen/remaining
 *      (kalau beda, sesuaikan abi[] + nama functionName)
 *   6. Fund wallet SEBELUM buka (script auto skip yg saldo kurang)
 *   7. Jalanin: node <file>.mjs   (auto pre-sign T-180s, blast di GO)
 *      Flags: --now (fire skrg), --dry (pre-sign only, no send)
 *   8. pm2: pakai --no-autorestart (one-shot, biar gak double-mint)
 *
 * HARD RULE (jangan dilanggar): ZERO RPC call di hot path. Pre-sign semua
 * offline sebelum buka. Di GO cuma sendRawTransaction. 1ms berharga.
 * (Kesalahan 2026-08-13 Squiggle: 0 NFT karena tx dibangun live = 3.7s telat.)
 * ============================================================================
 */
import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseEther,
  formatEther,
  parseGwei,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---- config ----------------------------------------------------------------
const RPC_URLS = (process.env.SQUIGGLE_RPC_URLS || process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RPC = RPC_URLS[0];               // primary = fastest (order matters)
const MINT = '0x2897e59840e6e3Deb1dBf56dD7F32d20C26a69eB';
const PRICE_PER = parseEther('0.0016');
const QTY_PER_TX = 2n;                 // contract max per tx
const TX_PER_WALLET = Number(process.env.SQUIGGLE_TX_PER_WALLET || 1); // burst per wallet (capped by balance)
const WALLET_KEYS = [2, 3, 4, 5, 6];   // WALLET_2..6 = pasukan 1-5
const GAS_LIMIT = BigInt(process.env.SQUIGGLE_GAS_LIMIT || 250000);
const PRIORITY_GWEI = process.env.SQUIGGLE_PRIORITY_GWEI || '0.5'; // tip; Robinhood ~FCFS, keep low
const POLL_MS = 100;                   // pre-open tight poll cadence
const RETRY_MS = 120;                  // retry cadence after open until land
const MAX_RETRY_SECONDS = Number(process.env.SQUIGGLE_MAX_RETRY_SECONDS || 120);
const PREARM_SECONDS = Number(process.env.SQUIGGLE_PREARM_SECONDS || 180); // pre-sign this long before open
const RESIGN_EVERY_MS = 30000;         // refresh signed tx (gas/nonce) every 30s while waiting

const FLAG_NOW = process.argv.includes('--now');
const FLAG_DRY = process.argv.includes('--dry');

const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
});

const abi = [
  { name: 'mint', type: 'function', stateMutability: 'payable', inputs: [{ type: 'uint256', name: 'quantity' }], outputs: [] },
  { name: 'saleOpen', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'saleStartTime', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'remaining', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

const pub = createPublicClient({ chain, transport: http(RPC) });
// One public client per RPC for parallel raw-tx broadcast (fastest landing wins).
const rpcClients = RPC_URLS.map((url) => ({ url, client: createPublicClient({ chain, transport: http(url, { timeout: 8000 }) }) }));
const MINT_VALUE = PRICE_PER * QTY_PER_TX; // 0.0032 ETH exact

function ts() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Load wallets
const wallets = [];
for (const i of WALLET_KEYS) {
  const raw = process.env[`WALLET_${i}_KEY`];
  if (!raw) { log(`WALLET_${i}_KEY missing — skipped`); continue; }
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain, transport: http(RPC) });
  // signed: array of ready raw tx blobs. nonceBase: first nonce. affordable: tx count balance allows.
  wallets.push({ idx: i, label: `pasukan ${i - 1}`, account, client, signed: [], nonceBase: 0n, affordable: 0, balance: 0n });
}
if (wallets.length === 0) { log('No wallets loaded. Abort.'); process.exit(1); }

const mintData = encodeFunctionData({ abi, functionName: 'mint', args: [QTY_PER_TX] });

/**
 * Compute gas params valid for a given balance.
 * EVM requires: value + gas*maxFeePerGas <= balance at inclusion. So the pre-signed
 * maxFeePerGas ceiling is bounded by leftover balance after the mint value. We set
 * the ceiling as high as the balance allows (protects vs base-fee spike) while the
 * ACTUAL paid = baseFee + tip stays tiny (~0.045 + 0.5 gwei on Robinhood).
 */
function gasParamsForBalance(balance, base) {
  const tip = parseGwei(String(PRIORITY_GWEI));
  // max ceiling the balance can back for ONE tx (value + gas*maxFee <= balance)
  const headroom = balance > MINT_VALUE ? (balance - MINT_VALUE) : 0n;
  let ceiling = headroom / GAS_LIMIT;                 // wei per gas
  // Don't go below baseFee+tip (tx must be includable), don't exceed a sane cap.
  const floor = base + tip;
  const hardCap = parseGwei('8');
  if (ceiling > hardCap) ceiling = hardCap;
  let maxFeePerGas = ceiling < floor ? floor : ceiling;
  return { maxFeePerGas, maxPriorityFeePerGas: tip };
}

/**
 * Pre-sign the full burst for one wallet, fully offline (account.signTransaction
 * does zero RPC calls). Fetches nonce+balance+baseFee via cheap reads, computes how
 * many tx the balance can back, then signs them all with sequential nonces.
 */
async function prearmWallet(w) {
  const [nonce, balance, block] = await Promise.all([
    pub.getTransactionCount({ address: w.account.address, blockTag: 'pending' }),
    pub.getBalance({ address: w.account.address }),
    pub.getBlock(),
  ]);
  w.nonceBase = BigInt(nonce);
  w.balance = balance;
  const base = block.baseFeePerGas ?? 0n;
  const { maxFeePerGas, maxPriorityFeePerGas } = gasParamsForBalance(balance, base);

  // How many tx the balance can back: each needs value + gas*maxFeePerGas.
  const perTxCost = MINT_VALUE + GAS_LIMIT * maxFeePerGas;
  let affordable = perTxCost > 0n ? Number(balance / perTxCost) : 0;
  if (affordable > TX_PER_WALLET) affordable = TX_PER_WALLET;
  w.affordable = affordable;

  if (affordable < 1) {
    w.signed = [];
    log(`❌ ${w.label} ${w.account.address} bal ${formatEther(balance)} ETH insufficient (need ~${formatEther(perTxCost)}/tx) — will skip`);
    return;
  }

  const signed = [];
  for (let t = 0; t < affordable; t++) {
    const raw = await w.account.signTransaction({
      to: MINT,
      data: mintData,
      value: MINT_VALUE,
      gas: GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: Number(w.nonceBase) + t,
      chainId: chain.id,
      type: 'eip1559',
    });
    signed.push(raw);
  }
  w.signed = signed;
  log(`🔏 ${w.label} pre-signed ${signed.length} tx (nonce ${w.nonceBase}+, maxFee ${Number(maxFeePerGas) / 1e9}gwei, bal ${formatEther(balance)} ETH)`);
}

async function prearmAll() {
  log(`🔧 Pre-arming ${wallets.length} wallets (sign ${TX_PER_WALLET} tx each, offline blobs)...`);
  await Promise.all(wallets.map((w) => prearmWallet(w).catch((e) => log(`⚠️ ${w.label} pre-arm error: ${(e.shortMessage || e.message || '').slice(0, 120)}`))));
  const totalTx = wallets.reduce((n, w) => n + w.signed.length, 0);
  log(`✅ Pre-arm ready: ${totalTx} signed tx across ${wallets.filter((w) => w.signed.length).length} funded wallets.`);
}

/** THE HOT PATH: blast every pre-signed blob to every RPC, zero prep, no awaits between sends. */
function fireAllPresigned() {
  const inflight = [];
  for (const w of wallets) {
    for (let k = 0; k < w.signed.length; k++) {
      const raw = w.signed[k];
      for (const r of rpcClients) {
        inflight.push(
          r.client
            .sendRawTransaction({ serializedTransaction: raw })
            .then((hash) => ({ w, k, hash, rpc: r.url }))
            .catch((e) => ({ w, k, err: (e.shortMessage || e.message || '').slice(0, 120), rpc: r.url }))
        );
      }
    }
  }
  return inflight;
}

/** After the blast: confirm receipts; for any wallet with no landed mint, re-sign fresh and resend until deadline/stock. */
async function confirmAndRetry(deadline) {
  const results = [];
  await Promise.all(
    wallets.map(async (w) => {
      if (w.signed.length === 0) { results.push({ wallet: w.label, address: w.account.address, minted: 0, error: 'INSUFFICIENT_BALANCE' }); return; }
      let minted = 0;
      let nonce = Number(w.nonceBase);
      // Try to confirm the pre-signed nonces first (fast path), then retry loop.
      for (let t = 0; t < w.signed.length; t++) {
        let landed = false;
        while (!landed && Date.now() < deadline) {
          try {
            // Re-sign fresh for retries (nonce/gas may have moved after first blast).
            const cnt = await pub.getTransactionCount({ address: w.account.address, blockTag: 'pending' });
            nonce = Number(cnt);
            const block = await pub.getBlock();
            const base = block.baseFeePerGas ?? 0n;
            const { maxFeePerGas, maxPriorityFeePerGas } = gasParamsForBalance(w.balance, base);
            const raw = await w.account.signTransaction({ to: MINT, data: mintData, value: MINT_VALUE, gas: GAS_LIMIT, maxFeePerGas, maxPriorityFeePerGas, nonce, chainId: chain.id, type: 'eip1559' });
            let hash;
            try {
              hash = await Promise.any(rpcClients.map((r) => r.client.sendRawTransaction({ serializedTransaction: raw })));
            } catch (agg) { throw agg?.errors?.[0] || agg; }
            const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 20000 });
            if (rcpt.status === 'success') { log(`✅ ${w.label} MINTED: ${hash} gasUsed=${rcpt.gasUsed}`); minted += Number(QTY_PER_TX); landed = true; }
            else { log(`↩️ ${w.label} reverted, retry...`); await sleep(RETRY_MS); }
          } catch (e) {
            const m = (e.shortMessage || e.message || '').slice(0, 140);
            if (/already known|nonce too low|replacement/i.test(m)) {
              // pre-signed tx already in mempool/mined — wait it out via receipt of that nonce
              await sleep(RETRY_MS);
            } else if (/sold|remaining|exceed|inventory|underflow|overflow/i.test(m)) {
              log(`🏁 ${w.label} stock/limit reached: ${m}`); landed = true;
            } else { await sleep(RETRY_MS); }
          }
        }
        if (!landed) log(`⌛ ${w.label} tx ${t + 1} not landed before deadline.`);
      }
      results.push({ wallet: w.label, address: w.account.address, minted });
    })
  );
  return results;
}

async function waitForOpenAndPrearm() {
  if (FLAG_NOW) { log('--now: pre-arm now then fire immediately.'); await prearmAll(); return; }
  const start = await pub.readContract({ address: MINT, abi, functionName: 'saleStartTime' });
  const startMs = Number(start) * 1000;
  log(`Sale start (on-chain): ${new Date(startMs).toISOString()} | now ${new Date().toISOString()}`);

  // Coarse wait until PREARM_SECONDS before open.
  while (Date.now() < startMs - PREARM_SECONDS * 1000) {
    const left = Math.round((startMs - Date.now()) / 1000);
    log(`⏳ ${left}s until pre-arm window (pre-sign at T-${PREARM_SECONDS}s)...`);
    await sleep(Math.min(15000, Math.max(1000, startMs - PREARM_SECONDS * 1000 - Date.now())));
  }

  // Pre-sign now (3 min early). Refresh periodically so gas/nonce stay current.
  await prearmAll();
  let lastResign = Date.now();
  log(`🕒 Armed. Holding until open, re-signing every ${RESIGN_EVERY_MS / 1000}s...`);
  while (true) {
    const now = Date.now();
    if (now >= startMs) { log('⏰ Sale start timestamp reached — GO.'); return; }
    // Cheap early-open check (in case contract opens before scheduled ts).
    if (startMs - now < 5000) {
      try { if (await pub.readContract({ address: MINT, abi, functionName: 'saleOpen' })) { log('🟢 saleOpen=true early — GO.'); return; } } catch { /* ignore */ }
      await sleep(POLL_MS);
    } else {
      if (now - lastResign >= RESIGN_EVERY_MS) { await prearmAll(); lastResign = now; }
      await sleep(Math.min(1000, startMs - now - 4000));
    }
  }
}

(async () => {
  log('=== Squiggle Wuiggle PRE-SIGN snipe minter ===');
  log(`RPCs (${rpcClients.length}, fastest-first): ${RPC_URLS.map((u) => u.replace(/\/v2\/.*/, '/v2/***').replace(/\/[0-9a-f]{20,}.*/, '/***')).join(' | ')}`);
  log(`Wallets: ${wallets.map((w) => `${w.label}(${w.account.address.slice(0, 8)})`).join(', ')}`);
  log(`Plan: up to ${TX_PER_WALLET} tx x ${QTY_PER_TX} token/wallet (balance-capped), ${wallets.length} wallets`);
  log(`Value/tx=${formatEther(MINT_VALUE)} ETH, gasLimit=${GAS_LIMIT}, tip=${PRIORITY_GWEI}gwei, prearm=T-${PREARM_SECONDS}s`);
  if (FLAG_DRY) log('MODE: DRY RUN (pre-sign only, no broadcast)');

  try {
    const rem = await pub.readContract({ address: MINT, abi, functionName: 'remaining' });
    log(`Stock remaining: ${rem}`);
    if (rem === 0n && !FLAG_DRY) { log('⚠️ remaining=0 already — sold out. Aborting.'); process.exit(0); }
  } catch (e) { log(`remaining read failed: ${(e.shortMessage || e.message)}`); }

  await waitForOpenAndPrearm();

  if (FLAG_DRY) {
    const totalTx = wallets.reduce((n, w) => n + w.signed.length, 0);
    log(`🧪 DRY: would blast ${totalTx} pre-signed tx x ${rpcClients.length} RPC = ${totalTx * rpcClients.length} sends at GO. No tx sent.`);
    log('=== RESULTS ===');
    log('TOTAL MINTED: 0 NFT (dry)');
    process.exit(0);
  }

  // ---- HOT PATH: fire pre-signed instantly ----
  const t0 = Date.now();
  const inflight = fireAllPresigned();
  log(`🔥 BLASTED ${inflight.length} sends (pre-signed) in ${Date.now() - t0}ms after GO.`);

  // Log the first send outcomes as they resolve (non-blocking for retry logic).
  Promise.allSettled(inflight).then((settled) => {
    let ok = 0, dup = 0, err = 0;
    for (const s of settled) {
      const v = s.value || {};
      if (v.hash) ok++;
      else if (v.err && /already known|nonce/i.test(v.err)) dup++;
      else err++;
    }
    log(`📡 Blast ack: ${ok} accepted, ${dup} dup/nonce, ${err} err.`);
  });

  const deadline = Date.now() + MAX_RETRY_SECONDS * 1000;
  const results = await confirmAndRetry(deadline);

  log('=== RESULTS ===');
  let total = 0;
  for (const r of results) { log(JSON.stringify(r)); if (r.minted) total += r.minted; }
  log(`TOTAL MINTED: ${total} NFT`);
  process.exit(0);
})();
