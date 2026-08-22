import { db } from './index';

/**
 * Generic key/value store for runtime-overridable config that must survive
 * restarts (e.g. the OpenSea API key set via /api). Values here take
 * precedence over .env at read time — see config.opensea.apiKey getter.
 */

export function getAppSetting(key: string): string | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string, updatedBy?: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`
  ).run(key, value, updatedBy ?? null);
}

export function deleteAppSetting(key: string): boolean {
  const res = db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  return res.changes > 0;
}

/** Metadata for display (who/when last changed a setting). */
export function getAppSettingMeta(
  key: string
): { value: string | null; updated_by: string | null; updated_at: string | null } | null {
  const row = db
    .prepare('SELECT value, updated_by, updated_at FROM app_settings WHERE key = ?')
    .get(key) as
    | { value: string | null; updated_by: string | null; updated_at: string | null }
    | undefined;
  return row ?? null;
}
