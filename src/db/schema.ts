export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  settings_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

export const CREATE_MINT_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS mint_jobs (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  collection_name TEXT,
  contract_address TEXT,
  seadrop_address TEXT,
  wallet_address TEXT,
  quantity INTEGER,
  mint_price_eth TEXT,
  status TEXT DEFAULT 'PENDING',
  tx_hash TEXT,
  token_ids TEXT,
  gas_used_eth TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

export const CREATE_BLACKLIST_TABLE = `
CREATE TABLE IF NOT EXISTS blacklist (
  contract_address TEXT PRIMARY KEY,
  reason TEXT,
  added_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

export const CREATE_AUDIT_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT,
  action TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

// Custom RPC endpoints per chain. When present for the active chain, the RPC
// client ranks them by measured latency and uses fastest-first with fallback.
export const CREATE_RPC_ENDPOINTS_TABLE = `
CREATE TABLE IF NOT EXISTS rpc_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_key TEXT NOT NULL,
  url TEXT NOT NULL,
  label TEXT,
  enabled INTEGER DEFAULT 1,
  last_latency_ms INTEGER,
  last_checked_at DATETIME,
  added_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chain_key, url)
)
`;

// HTTP(S)/SOCKS proxies for OpenSea API calls. Rotated per-wallet so N wallets
// hit OpenSea from N different IPs, bypassing per-IP rate limits (429).
export const CREATE_PROXIES_TABLE = `
CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  label TEXT,
  enabled INTEGER DEFAULT 1,
  last_latency_ms INTEGER,
  last_ok INTEGER,
  last_checked_at DATETIME,
  added_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

export const CREATE_SCHEDULED_MINTS_TABLE = `
CREATE TABLE IF NOT EXISTS scheduled_mints (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  url TEXT NOT NULL,
  scheduled_time DATETIME NOT NULL,
  quantity INTEGER DEFAULT 1,
  force_max_quantity INTEGER DEFAULT 0,
  wallet_from INTEGER,
  wallet_to INTEGER,
  status TEXT DEFAULT 'PENDING',
  job_id TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME
)
`;

// Generic key/value app settings (runtime-overridable config that must survive
// restarts). Used to hot-swap the OpenSea API key via /api without editing .env.
export const CREATE_APP_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

export const CREATE_UPDATED_AT_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS update_mint_jobs_updated_at
AFTER UPDATE ON mint_jobs
BEGIN
  UPDATE mint_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END
`;

// Indexes for performance
export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_mint_jobs_telegram_id ON mint_jobs(telegram_id);
CREATE INDEX IF NOT EXISTS idx_mint_jobs_status ON mint_jobs(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_telegram_id ON audit_logs(telegram_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_mints_telegram_id ON scheduled_mints(telegram_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_mints_status ON scheduled_mints(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_mints_scheduled_time ON scheduled_mints(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_chain ON rpc_endpoints(chain_key);
CREATE INDEX IF NOT EXISTS idx_proxies_enabled ON proxies(enabled);
`;
