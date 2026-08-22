import { db } from './index';

export interface RpcEndpoint {
  id: number;
  chain_key: string;
  url: string;
  label: string | null;
  enabled: number;
  last_latency_ms: number | null;
  last_checked_at: string | null;
  added_by: string | null;
  created_at: string;
}

/** Add (or re-enable) a custom RPC endpoint for a chain. Idempotent on (chain, url). */
export function addRpcEndpoint(
  chainKey: string,
  url: string,
  label?: string,
  addedBy?: string
): void {
  db.prepare(
    `INSERT INTO rpc_endpoints (chain_key, url, label, enabled, added_by)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(chain_key, url) DO UPDATE SET enabled = 1, label = COALESCE(excluded.label, rpc_endpoints.label)`
  ).run(chainKey, url.trim(), label ?? null, addedBy ?? null);
}

/** Remove an RPC endpoint by url (or id) for a chain. Returns true if a row changed. */
export function removeRpcEndpoint(chainKey: string, urlOrId: string): boolean {
  const asId = Number(urlOrId);
  if (Number.isInteger(asId) && String(asId) === urlOrId.trim()) {
    return db.prepare('DELETE FROM rpc_endpoints WHERE chain_key = ? AND id = ?').run(chainKey, asId).changes > 0;
  }
  return db.prepare('DELETE FROM rpc_endpoints WHERE chain_key = ? AND url = ?').run(chainKey, urlOrId.trim()).changes > 0;
}

/** All endpoints for a chain, fastest measured first (unmeasured last), enabled first. */
export function getRpcEndpoints(chainKey: string, onlyEnabled = false): RpcEndpoint[] {
  const where = onlyEnabled ? 'WHERE chain_key = ? AND enabled = 1' : 'WHERE chain_key = ?';
  return db
    .prepare(
      `SELECT * FROM rpc_endpoints ${where}
       ORDER BY enabled DESC,
                CASE WHEN last_latency_ms IS NULL THEN 1 ELSE 0 END ASC,
                last_latency_ms ASC,
                id ASC`
    )
    .all(chainKey) as RpcEndpoint[];
}

/** Ordered list of enabled RPC URLs for a chain, fastest-first. */
export function getRankedRpcUrls(chainKey: string): string[] {
  return getRpcEndpoints(chainKey, true).map((e) => e.url);
}

/** Persist a measured latency (ms) for an endpoint; null marks it unreachable. */
export function updateRpcLatency(chainKey: string, url: string, latencyMs: number | null): void {
  db.prepare(
    `UPDATE rpc_endpoints
     SET last_latency_ms = ?, last_checked_at = CURRENT_TIMESTAMP
     WHERE chain_key = ? AND url = ?`
  ).run(latencyMs, chainKey, url.trim());
}

/** Enable/disable an endpoint without deleting it. */
export function setRpcEnabled(chainKey: string, url: string, enabled: boolean): boolean {
  return db
    .prepare('UPDATE rpc_endpoints SET enabled = ? WHERE chain_key = ? AND url = ?')
    .run(enabled ? 1 : 0, chainKey, url.trim()).changes > 0;
}
