# Hitamlegam setup notes

Standalone SeaDrop Telegram minter. This is separate from `/root/.openclaw/workspace/whitelist-template.js` and does not touch the private FCFS whitelist bot.

## Needed before start
- TELEGRAM_BOT_TOKEN from BotFather
- ADMIN_TELEGRAM_ID
- ALCHEMY_API_KEY
- OPENSEA_API_KEY
- ETHERSCAN_API_KEY
- burner wallet keys only: WALLET_1_KEY, WALLET_2_KEY, ...

## Recommended safety changes before production
- keep all write/mint commands admin-only
- use a fresh Telegram bot token, not shared with Cely/OpenClaw
- use low-funded burner wallets only
- start in DRY_RUN_MODE=true first

## Run
npm run build
pm2 start dist/index.js --name seadrop-telegram-minter
pm2 save


## Local hardening already applied
- All commands, including /start and /help, are admin-only.
- Commands are accepted only in private DM from ADMIN_TELEGRAM_ID.
- `.env.hitamlegam.example` sets `ADMIN_TELEGRAM_ID=1449297202` and `DRY_RUN_MODE=true` by default.
- This remains fully separate from `/root/.openclaw/workspace/whitelist-template.js`.
