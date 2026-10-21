import { db } from './index';

export interface ProxyEntry {
  id: number;
  url: string;
  label: string | null;
  enabled: number;
  last_latency_ms: number | null;
  last_ok: number | null;
  last_checked_at: string | null;
  added_by: string | null;
  created_at: string;
}

/**
 * Supported proxy URL forms:
 *   http://user:pass@host:port
 *   http://host:port
 *   https://user:pass@host:port
 *   socks5://user:pass@host:port  (requires socks-proxy-agent; http(s) works out of the box)
 */
export function addProxy(url: string, label?: string, addedBy?: string): void {
  db.prepare(
    `INSERT INTO proxies (url, label, enabled, added_by)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(url) DO UPDATE SET enabled = 1, label = COALESCE(excluded.label, proxies.label)`
  ).run(url.trim(), label ?? null, addedBy ?? null);
}

/** Add many proxies at once (bulk paste). Returns count inserted/updated. */
export function addProxiesBulk(urls: string[], addedBy?: string): number {
  const stmt = db.prepare(
    `INSERT INTO proxies (url, enabled, added_by)
     VALUES (?, 1, ?)
     ON CONFLICT(url) DO UPDATE SET enabled = 1`
  );
  const tx = db.transaction((list: string[]) => {
    let n = 0;
    for (const u of list) {
      const clean = u.trim();
      if (clean) {
        stmt.run(clean, addedBy ?? null);
        n += 1;
      }
    }
    return n;
  });
  return tx(urls);
}

export function removeProxy(urlOrId: string): boolean {
  const asId = Number(urlOrId);
  if (Number.isInteger(asId) && String(asId) === urlOrId.trim()) {
    return db.prepare('DELETE FROM proxies WHERE id = ?').run(asId).changes > 0;
  }
  return db.prepare('DELETE FROM proxies WHERE url = ?').run(urlOrId.trim()).changes > 0;
}

export function clearProxies(): number {
  return db.prepare('DELETE FROM proxies').run().changes;
}

/** All proxies, healthy+fastest first (ok before dead, then latency asc). */
export function getProxies(onlyEnabled = false): ProxyEntry[] {
  const where = onlyEnabled ? 'WHERE enabled = 1' : '';
  return db
    .prepare(
      `SELECT * FROM proxies ${where}
       ORDER BY enabled DESC,
                CASE WHEN last_ok = 1 THEN 0 WHEN last_ok IS NULL THEN 1 ELSE 2 END ASC,
                CASE WHEN last_latency_ms IS NULL THEN 1 ELSE 0 END ASC,
                last_latency_ms ASC,
                id ASC`
    )
    .all() as ProxyEntry[];
}

/** Enabled proxy URLs, healthy-first, for rotation. */
export function getEnabledProxyUrls(): string[] {
  return getProxies(true).map((p) => p.url);
}

export function updateProxyHealth(url: string, latencyMs: number | null): void {
  db.prepare(
    `UPDATE proxies
     SET last_latency_ms = ?, last_ok = ?, last_checked_at = CURRENT_TIMESTAMP
     WHERE url = ?`
  ).run(latencyMs, latencyMs === null ? 0 : 1, url.trim());
}

export function setProxyEnabled(url: string, enabled: boolean): boolean {
  return db
    .prepare('UPDATE proxies SET enabled = ? WHERE url = ?')
    .run(enabled ? 1 : 0, url.trim()).changes > 0;
}

export function getProxyCount(onlyEnabled = false): number {
  const q = onlyEnabled
    ? 'SELECT COUNT(*) AS c FROM proxies WHERE enabled = 1'
    : 'SELECT COUNT(*) AS c FROM proxies';
  return (db.prepare(q).get() as { c: number }).c;
}
