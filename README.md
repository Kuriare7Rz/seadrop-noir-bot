# SeaDrop Mint Bot

An open source, self-hosted Telegram bot that automatically mints NFTs from **OpenSea SeaDrop / Drops** collections. Built for timed WL/allowlist drops: it reads drop stages, waits for the eligible window, and fires with a low-latency snipe path across many burner wallets.

Supports **Ethereum mainnet** and **Robinhood Chain**, up to 100 concurrent wallets, per-user settings, scheduled stage-aware mints, RPC ranking with fallback, proxy rotation to dodge rate limits, and full risk validation before every mint.

> ⚠️ Self-hosted, burner-wallet tooling. No warranty. Use at your own risk. Not affiliated with OpenSea.

## 🙏 Credits

**Noir is the V2 upgrade of [seadrop_nft_minter](https://github.com/Taqiyaoezanik/seadrop_nft_minter) by [@Taqiyaoezanik](https://github.com/Taqiyaoezanik).** The original bot laid the foundation — the Telegram mint queue, wallet pool, and risk validation. Noir builds on top of it with multi-chain support (Ethereum + Robinhood Chain), DB-backed RPC ranking, per-wallet proxy rotation, runtime OpenSea API key hot-swap, the Window Guard + snipe V2 hot path, and `/wl` eligibility checking. Full credit for the original work goes to its author.

---

## ✨ Features

- 🤖 **Automated minting** — queue mints; the bot resolves, validates, and executes end-to-end
- 🎫 **Stage-aware WL/allowlist** — reads OpenSea drop stages (public / signed presale / allowlist) and lets OpenSea auto-select the stage your wallet is eligible for; never force-picks public
- 🎟 **WL eligibility checker (`/wl`)** — before committing to a mint, check *every* pool wallet against a drop in one matrix: OpenSea gated eligibility via SIWE + `DropEligibilityQuery` (authoritative) plus SeaDrop on-chain state (public stage, caps, supply, allowlist root)
- 🛡️ **Window Guard** — if a stage hasn't opened, polls until *any* eligible stage goes live, then fires (no early 422 spam)
- 🚀 **Snipe mode** — pre-arms wallet + gas before open, hammers `/mint` until it returns a signed tx, then broadcasts instantly (skips live `estimateGas` on the hot path)
- 📡 **Parallel broadcast** — signs once and blasts the raw tx to *all* ranked RPCs simultaneously; first landing wins
- 🌐 **RPC management** — DB-backed custom RPCs, benchmarked and ranked fastest-first with automatic viem fallback
- 🔒 **Proxy rotation** — per-wallet proxy assignment so N wallets hit OpenSea from N IPs, bypassing per-IP `429`; built-in backoff + jitter when no proxies are set
- ⏰ **Scheduled mints** — schedule for a specific time (WIB), with optional wallet ranges
- 💰 **Multi-wallet** — up to 100 concurrent burner wallets with a PQueue-bounded parallel mint loop
- ⛓️ **Multi-chain** — Ethereum + Robinhood Chain, each with a tuned snipe profile
- 🔑 **Runtime API key control** — `/api` hot-swaps the OpenSea key without a redeploy (validated before it's saved)
- 🧪 **Dry-run mode** — simulate mints via `eth_call`, no transaction sent
- 📊 **Per-user settings** — each user configures their own price/gas/quantity/priority limits
- 🕒 **NTP clock check** — verifies host clock drift at boot so scheduled snipes fire on time
- 🔎 **Risk validation** — blacklist, Etherscan verification, contract age, GoPlus security scan

---

## Prerequisites

- **Node.js** v20+ and **npm** v9+
- **Redis** (optional — enables a persistent BullMQ job queue across restarts)
- API keys: Telegram Bot, Alchemy (Ethereum), OpenSea API v2, Etherscan

---

## Installation

```bash
# 1. Clone
git clone https://github.com/Kuriare7Rz/seadrop-noir-bot.git
cd seadrop-noir-bot

# 2. Install dependencies
npm install

# 3. Copy the environment template
cp .env.example .env

# 4. Fill in .env (see the configuration guide below)
nano .env

# 5. Build TypeScript
npm run build

# 6. Start
npm start
```

Type-check without emitting: `npm run typecheck`.

---

## .env Configuration Guide

### Core (required)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From [@BotFather](https://t.me/BotFather) |
| `ADMIN_TELEGRAM_ID` | ✅ | Your Telegram numeric user ID (admin-only commands) |
| `ALCHEMY_API_KEY` | ✅ | From [alchemy.com](https://alchemy.com) (Ethereum primary RPC) |
| `BACKUP_RPC_URL` | — | Fallback RPC (default: `cloudflare-eth.com`) |
| `OPENSEA_API_KEY` | ✅ | OpenSea API v2 key (can be hot-swapped at runtime via `/api`) |
| `ETHERSCAN_API_KEY` | ✅ | From [etherscan.io/apis](https://etherscan.io/apis) |

### Mint defaults (overridable per-user via `/set_*`)

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_MAX_MINT_PRICE_ETH` | `0.1` | Max mint price guard |
| `DEFAULT_MAX_GAS_ETH` | `0.005` | Max gas spend guard |
| `DEFAULT_QUANTITY` | `1` | Quantity per job |
| `LOW_BALANCE_THRESHOLD_ETH` | `0.0001` | Warn below this balance |
| `LOW_BALANCE_ALERTS` | `false` | Push low-balance warnings to Telegram (balance is always checked + logged regardless) |
| `MAX_PRIORITY_FEE_GWEI` | `0.01` | EIP-1559 priority fee (decimals OK) |
| `TX_TIMEOUT_SECONDS` | `120` | Transaction wait timeout |
| `QUEUE_CONCURRENCY` | `10` | Max concurrent mint jobs |
| `MULTI_WALLET_CONCURRENCY` | `5` | Wallets minting in parallel (1–100) |
| `MULTI_WALLET_PROGRESS_INTERVAL` | `10` | Progress log interval (s) |
| `GOPLUS_STRICT_MODE` | `false` | Block mint if GoPlus API is unavailable |
| `DRY_RUN_MODE` | `false` | Force all `/mint` to simulate (no tx sent) |

### Multi-chain

| Variable | Default | Description |
|---|---|---|
| `MINT_CHAIN` | `ethereum` | Active chain: `ethereum` or `robinhood` |
| `ROBINHOOD_RPC_URL` | public RPC | Robinhood Chain RPC (used when `MINT_CHAIN=robinhood`) |

### Window Guard (stage-aware)

| Variable | Default | Description |
|---|---|---|
| `WINDOW_GUARD_ENABLED` | `true` | Poll until an eligible stage opens, then fire |
| `WINDOW_GUARD_MAX_WAIT_SECONDS` | `900` | Max wait before giving up |
| `WINDOW_GUARD_POLL_MS` | `3000` | Poll interval while waiting |
| `SCHEDULE_AUTO_ALIGN` | `true` | Align schedule time to stage start if set too early |

### Snipe mode

Chain-aware knobs are **blank by default** → they inherit the active chain's tuned profile in `src/chains.ts`. Set a value only to force-override across all chains.

| Variable | Default | Description |
|---|---|---|
| `SNIPE_ENABLED` | `true` | Enable the snipe fast-path for scheduled mints |
| `SNIPE_RPC_PRECHECK` | `true` | Benchmark + re-rank RPCs during pre-arm |
| `SNIPE_PARALLEL_BROADCAST` | `true` | Blast signed tx to all ranked RPCs (first wins) |
| `SNIPE_MAX_HAMMER_SECONDS` | `60` | Max hammer duration |
| `SNIPE_LEAD_MS` | profile | Start hammering N ms before open |
| `SNIPE_HAMMER_INTERVAL_MS` | profile | ms between `/mint` attempts |
| `SNIPE_PRIORITY_FEE_GWEI` | profile | Priority fee on snipe path |
| `SNIPE_GAS_LIMIT` | profile | Fixed gas limit (skips `estimateGas`) |
| `SNIPE_BASEFEE_MULTIPLIER` | profile | `maxFee = baseFee * mult + tip` |

### Proxy + rate limiting

| Variable | Default | Description |
|---|---|---|
| `PROXY_ENABLED` | `true` | Master switch (only active if the DB proxy pool is non-empty) |
| `PROXY_CHECK_TIMEOUT_MS` | `8000` | Timeout for `/check_proxy` health checks |
| `RATE_LIMIT_BACKOFF_MS` | `1000` | Wait on `429` (or `Retry-After` if provided) |
| `HAMMER_JITTER_MS` | `120` | Random 0..N ms per attempt to spread bursts |
| `RATE_LIMIT_MAX` | `5` | Command rate limit per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |

### Optional

| Variable | Description |
|---|---|
| `REDIS_URL` | Enables BullMQ persistent queue; falls back to in-memory p-queue if unset |

---

## Adding Burner Wallets

Add private keys to `.env`:

```env
WALLET_1_KEY=0x<burner_key_1>
WALLET_2_KEY=0x<burner_key_2>
WALLET_3_KEY=0x<burner_key_3>
# ... up to WALLET_100_KEY
```

- Supports up to **100 wallets** (`WALLET_1_KEY` … `WALLET_100_KEY`)
- Each wallet is exclusively assigned to one job at a time
- `/wallets` shows balances + status; `/add_wallet <key>` adds one at runtime; `/admin_reload` reloads from `.env` without restart

> ⚠️ **Use burner wallets only.** Never load wallets holding significant funds.

---

## Running the Bot

```bash
# Development (ts-node/tsx watch)
npm run dev

# Production (Node.js)
npm run build && npm start

# Production (Docker, no Redis)
docker compose up -d bot

# Production (Docker + Redis persistent queue)
docker compose --profile redis up -d
```

---

## OpenSea API Key Management (`/api`)

The OpenSea key can expire or get revoked. A dead key makes the Drops API return `401`, which previously caused the bot to silently fall back to on-chain public-only detection and misreport WL/presale drops as *"Mint has not started yet"* (stages/target vanish).

`/api` fixes this: it hot-swaps the key at runtime (stored in the DB, surviving restarts and taking precedence over `.env`), and the mint flow now fails loudly and actionably on auth errors instead of firing blind.

| Command | Description |
|---|---|
| `/api` | Show the active key + source (`.env` or runtime override) |
| `/api status` | Show the key **plus a live auth probe** |
| `/api test [slug]` | Live-verify the effective key against the Drops API |
| `/api set <key>` | Validate, persist, and hot-apply a new key (admin). The message containing the key is auto-deleted |
| `/api reset` | Drop the override and fall back to the `.env` key (admin) |

**Getting a key:** free keys can be created with `POST https://api.opensea.io/api/v2/auth/keys` (no auth needed). Limits: read 600/h, write 30/h; **max 2 keys/day**, **expire after 7 days**. For higher limits, request one from the [OpenSea Developer Portal](https://docs.opensea.io).

---

## Scheduled Mints

Schedule mints to fire automatically at a set time (times are **WIB / Asia-Jakarta**), ideal for timed WL drops.

```bash
# Schedule for 10 PM tonight
/schedule_mint https://opensea.io/collection/<slug> 22:00

# Wallet range (wallets 1–5)
/schedule_mint https://opensea.io/collection/<slug> 22:00 1 5

# Max quantity per wallet
/schedule_mint_max https://opensea.io/collection/<slug> 23:00 1 67

# View / cancel
/list_schedules
/cancel_schedule <schedule_id>
```

- The scheduler checks for due jobs on a short interval and queues them at the target time.
- With snipe mode on, a scheduled job pre-arms before the window and fires within the first live moment of the eligible stage.
- All wallets = `1 67`; pasukan-only (skip wallet 1) = `2 67`.

---

## Command Reference

| Command | Description |
|---|---|
| `/start` | Welcome + wallet pool status |
| `/help` | Show all commands |
| **Minting** | |
| `/mint <url>` | Mint a collection by OpenSea URL |
| `/mint_max <url> [from] [to]` | Mint max quantity, optional wallet range |
| `/dryrun <url>` / `/preflight <url>` | Simulate a mint (no tx sent) |
| `/confirm` | Confirm a pending high-value mint |
| `/status` | Your active mint jobs |
| `/status_plus` | Detailed status view |
| `/history` | Last 20 mint transactions |
| `/cancel <job_id>` | Cancel a pending job |
| **Whitelist Check** | |
| `/wl <url \| slug \| contract>` | Eligibility matrix for all pool wallets: OpenSea gated stages (SIWE) + SeaDrop on-chain state |
| **Scheduled Mints** | |
| `/schedule_mint <url> <time> [from] [to]` | Schedule a mint (WIB) |
| `/schedule_mint_max <url> <time> [from] [to]` | Schedule a max-quantity mint |
| `/list_schedules` | List your schedules |
| `/cancel_schedule <id>` | Cancel a scheduled mint |
| **OpenSea API Key** | |
| `/api` · `/api status` · `/api test [slug]` | Inspect / verify the key |
| `/api set <key>` · `/api reset` | Set or reset the key (admin) |
| **RPC (speed + fallback)** | |
| `/rpcs` | List RPCs for the active chain, fastest-first |
| `/check_rpc` | Benchmark + re-rank all RPCs |
| `/add_rpc <url> [label]` | Add an RPC (admin) |
| `/del_rpc <url\|#>` | Remove an RPC (admin) |
| `/toggle_rpc <url>` | Enable/disable an RPC (admin) |
| **Proxy (bypass 429)** | |
| `/proxies` | List the proxy pool + health |
| `/check_proxy` | Test proxies, verify distinct exit IPs |
| `/add_proxy <url> [label]` | Add one, or paste many (admin) |
| `/del_proxy <url\|#>` | Remove one (admin) |
| `/clear_proxies` | Wipe the pool (admin) |
| `/toggle_proxy <url>` | Enable/disable one (admin) |
| **Wallets** | |
| `/wallets` | Wallet pool: address, balance, status |
| `/add_wallet <key>` | Add a wallet at runtime (admin) |
| **Settings** | |
| `/settings` | Show current settings |
| `/set_maxprice <eth>` | Set max mint price |
| `/set_maxgas <eth>` | Set max gas fee |
| `/set_quantity <n>` | Set quantity per job |
| `/set_priorityfee <gwei>` | Set EIP-1559 priority fee |
| **Chain / Admin** | |
| `/chain [key]` | Show or switch the active chain (admin) |
| `/blacklist <contract>` | Add contract to blacklist (admin) |
| `/whitelist <contract>` | Remove from blacklist (admin) |
| `/admin_stats` | Mints, success rate, gas spent (admin) |
| `/admin_reload` | Reload wallet pool from `.env` (admin) |
| `/admin_blacklist` | Show full blacklist (admin) |
| `/panic` | Emergency stop (admin) |

---

## Architecture Overview

```
Telegram User
      │
      ▼
┌──────────────────────────────────────────────┐
│              TELEGRAF BOT LAYER               │
│  middleware: auth (admin), rate limit         │
│  commands: mint, schedule, api, rpc, proxy,   │
│            wallet, settings, chain, admin     │
└───────────────┬──────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────┐
│                 QUEUE LAYER                   │
│  p-queue (in-memory)  ·  BullMQ + Redis (opt) │
└───────────────┬──────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────┐
│                 MINT ENGINE                   │
│  urlParser → collectionResolver               │
│  → checkIfDrop (OpenSea Drops API)            │
│     ├─ stage-aware: anyStageOpen / nextStage  │
│     ├─ Window Guard: wait for eligible stage  │
│     └─ Snipe: pre-arm → hammer /mint → blast  │
│  → dropMinter (signed tx from OpenSea)        │
│  fallback → seadropDetector → mintConfigReader│
│           → calldataBuilder → gasEstimator    │
│  → dryRun (eth_call) → transactionSender      │
│  → txMonitor                                  │
└──────┬───────────────────────┬────────────────┘
       │                       │
       ▼                       ▼
┌───────────────┐     ┌────────────────────────┐
│  WALLET LAYER │     │      RISK LAYER        │
│  pool         │     │  validator             │
│  balanceCheck │     │  blacklist             │
│  keys (100)   │     │  etherscanCheck        │
└───────────────┘     │  goplusCheck           │
       │              └────────────────────────┘
       ▼
┌──────────────────────────────────────────────┐
│               INFRASTRUCTURE                  │
│  rpc/client   — ranked RPCs + viem fallback   │
│  rpc/proxyPool — per-wallet proxy rotation    │
│  db (SQLite / better-sqlite3):                │
│     users, mint_jobs, scheduled_mints,        │
│     blacklist, audit_logs, rpc_endpoints,     │
│     proxies, app_settings                     │
│  config (Zod + dotenv)                        │
│  chains — per-chain snipe profiles            │
│  utils/clockCheck — NTP drift guard           │
└──────────────────────────────────────────────┘
```

### OpenSea Drops mint flow (primary path)

1. `checkIfDrop(slug)` reads the drop + its stages from the OpenSea Drops API.
   - On `401/403` it raises an auth error (surface to `/api`) instead of silently degrading.
2. Stage logic decides whether a stage is open now or opens soon.
   - **Snipe:** pre-arm wallet + gas, hammer `POST /drops/{slug}/mint` until it returns a signed tx.
   - **Window Guard:** if nothing's open yet, poll until any eligible stage goes live.
3. OpenSea returns the ready-to-send transaction (it auto-selects the stage your wallet is eligible for — WL, presale, or public).
4. `transactionSender` signs and broadcasts. With >1 RPC, `sendMintTransactionParallel` blasts to all ranked RPCs; first landing wins.

### Fallback: manual on-chain SeaDrop

If a collection is not served by the Drops API, the bot detects the SeaDrop contract on-chain, reads the public drop config, builds the calldata, and mints directly:

```
tx.to = SeaDrop contract (e.g. 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5)
mintPublic(nftContract, feeRecipient, address(0), quantity)
    └── SeaDrop validates → ERC721SeaDrop.mintSeaDrop() → NFT minted
```

---

## Security Warnings

> ⚠️ Designed for self-hosted deployment only.

1. **Protect `.env`** — it holds private keys and API keys. `chmod 600 .env`.
2. **Burner wallets only.** Never load wallets with significant ETH or valuable NFTs.
3. **Never commit `.env`** — it's gitignored by default (along with `*.db` and `logs/`).
4. **Private keys are never logged, displayed, or transmitted.** Verify this yourself before deploying.
5. **Run on a trusted server.** Anyone with server/DB access can read secrets.
6. **The `/api` key is stored in the local SQLite DB** (`data/bot.db`), which is gitignored — keep the server secured.
7. **No warranty.** Open source; use at your own risk.

---

## Gas Optimization

Tuned for minimal gas while staying competitive on timed drops.

- `MAX_PRIORITY_FEE_GWEI=0.01`, `DEFAULT_MAX_GAS_ETH=0.005`
- Gas limit buffer 10%; base fee buffer 0% (raw baseFee); dynamic priority fee from recent blocks, capped for safety.
- On the snipe path a fixed `gasLimit` is used to skip a live `estimateGas` RPC round-trip.

```
maxFeePerGas = baseFee * baseFeeMultiplier + priorityFee
gasLimit     = estimateGas * 1.10   (or fixed SNIPE_GAS_LIMIT on the hot path)
totalGasCost = gasLimit * maxFeePerGas
```

**Per-chain snipe profiles** (`src/chains.ts`):

| Chain | Priority fee | baseFee mult | Hammer interval | Lead | Gas limit |
|---|---|---|---|---|---|
| Ethereum | 2 gwei | 3× | 150 ms | 800 ms | 250,000 |
| Robinhood | 0 gwei | 4× | 50 ms | 1200 ms | 300,000 |

Tuning: lower `MAX_PRIORITY_FEE_GWEI` for cheaper/slower; raise for faster confirms; `/set_priorityfee 2` for an urgent one-off.

---

## Risk Controls

Before every mint the bot checks:

1. URL is valid and from opensea.io
2. Collection is on the active chain
3. Contract is not in the local blacklist
4. Contract is verified on Etherscan
5. Contract is older than 1 hour
6. GoPlus security scan (honeypot / malicious behavior)
7. SeaDrop interface / drop detected
8. Mint is currently active (stage open)
9. Supply is available
10. Mint price within your configured limit
11. Gas estimate within your configured limit
12. An idle wallet is available

---

## Project Layout

```
src/
  bot/          Telegraf bot: commands/ + middleware (auth, rate limit)
  mint/         engine, dropDetector, dropMinter, seadropDetector,
                mintConfigReader, calldataBuilder, gasEstimator,
                transactionSender, txMonitor, dryRun, openseaAuth
  whitelist/    /wl checker: siwe (OpenSea eligibility), seadrop (on-chain), check (orchestrator)
  rpc/          client (ranked + fallback), proxyPool
  wallet/       pool, balanceChecker
  risk/         validator, blacklist, etherscanCheck, goplusCheck
  db/           SQLite tables + accessors (incl. app_settings, rpcEndpoints, proxies)
  config/       Zod-validated env
  chains.ts     per-chain profiles + snipe tuning
  utils/        logger, clockCheck
```


---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit: `git commit -m 'feat: add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

Follow the existing style: TypeScript strict mode, no `any`, explicit return types. Run `npm run typecheck` and `npm run build` before submitting.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by OpenSea, Alchemy, Etherscan, or any third-party service mentioned here.
