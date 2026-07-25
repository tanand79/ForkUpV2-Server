/**
 * Platform settings helpers (key/value store).
 * Inputs: setting keys. Outputs: string values / bulk maps.
 * Used by Super Admin (AI model, fee %, SMTP) and mailer/ai-chat readers.
 */
import { pool } from "../db/pool";

export async function getPlatformSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ setting_value: string }>(
    `SELECT setting_value FROM platform_settings WHERE setting_key = $1`,
    [key],
  );
  return rows[0]?.setting_value ?? null;
}

export async function getPlatformSettings(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const { rows } = await pool.query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value
     FROM platform_settings
     WHERE setting_key = ANY($1::text[])`,
    [keys],
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.setting_key] = row.setting_value;
  return out;
}

export async function setPlatformSetting(
  key: string,
  value: string,
  updatedByUserId?: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_at, updated_by_user_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value,
           updated_at = NOW(),
           updated_by_user_id = EXCLUDED.updated_by_user_id`,
    [key, value, updatedByUserId ?? null],
  );
}

export async function setPlatformSettings(
  entries: Record<string, string>,
  updatedByUserId?: number | null,
): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await setPlatformSetting(key, value, updatedByUserId);
  }
}
