"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlatformSetting = getPlatformSetting;
exports.getPlatformSettings = getPlatformSettings;
exports.setPlatformSetting = setPlatformSetting;
exports.setPlatformSettings = setPlatformSettings;
const pool_1 = require("../db/pool");
async function getPlatformSetting(key) {
    const { rows } = await pool_1.pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key = $1`, [key]);
    return rows[0]?.setting_value ?? null;
}
async function getPlatformSettings(keys) {
    if (keys.length === 0)
        return {};
    const { rows } = await pool_1.pool.query(`SELECT setting_key, setting_value
     FROM platform_settings
     WHERE setting_key = ANY($1::text[])`, [keys]);
    const out = {};
    for (const row of rows)
        out[row.setting_key] = row.setting_value;
    return out;
}
async function setPlatformSetting(key, value, updatedByUserId) {
    await pool_1.pool.query(`INSERT INTO platform_settings (setting_key, setting_value, updated_at, updated_by_user_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value,
           updated_at = NOW(),
           updated_by_user_id = EXCLUDED.updated_by_user_id`, [key, value, updatedByUserId ?? null]);
}
async function setPlatformSettings(entries, updatedByUserId) {
    for (const [key, value] of Object.entries(entries)) {
        await setPlatformSetting(key, value, updatedByUserId);
    }
}
//# sourceMappingURL=platform-settings.js.map