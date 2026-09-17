/**
 * Pass D3 — additive migration: Join Us giveback / cause prefs on businesses.
 *
 * Purpose: Persist 4-step funnel choices (giveback mode, cause mode, optional
 * campaign slug) beyond sessionStorage after email join.
 *
 * Inputs: none (uses pool).
 * Outputs: nullable columns on businesses. Existing rows stay NULL.
 *
 * Changelog (D3): Added join_giveback_mode, join_cause_mode, join_preferred_campaign_slug.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

/**
 * Full DDL (additive only). Safe to re-run:
 * - ADD COLUMN IF NOT EXISTS
 * - DROP CONSTRAINT IF EXISTS then ADD CHECK
 */
export const JOIN_GIVEBACK_PREFS_DDL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS join_giveback_mode VARCHAR(40) NULL;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS join_cause_mode VARCHAR(20) NULL;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS join_preferred_campaign_slug VARCHAR(255) NULL;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_join_giveback_mode_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_join_giveback_mode_check
  CHECK (
    join_giveback_mode IS NULL OR join_giveback_mode IN (
      'restaurant_dine_percent',
      'percent_of_purchase',
      'dollar_per_visit',
      'special_offer'
    )
  );

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_join_cause_mode_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_join_cause_mode_check
  CHECK (
    join_cause_mode IS NULL OR join_cause_mode IN ('pick_now', 'forkup_match')
  );

COMMENT ON COLUMN businesses.join_giveback_mode IS
  'Pass D3: Giveback choice from Join Us — restaurant_dine_percent | percent_of_purchase | dollar_per_visit | special_offer.';

COMMENT ON COLUMN businesses.join_cause_mode IS
  'Pass D3: Cause choice — pick_now | forkup_match.';

COMMENT ON COLUMN businesses.join_preferred_campaign_slug IS
  'Pass D3: Optional campaign slug when cause mode is pick_now.';
`;

/**
 * Apply join giveback/cause preference columns.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateJoinGivebackPrefs(options: DbTaskOptions = {}) {
  await pool.query(JOIN_GIVEBACK_PREFS_DDL);
  console.log(
    "ForkUp join giveback prefs applied on businesses (giveback_mode | cause_mode | preferred_campaign_slug).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateJoinGivebackPrefs().catch((err) => {
    console.error("join giveback prefs migration failed:", err);
    process.exit(1);
  });
}
