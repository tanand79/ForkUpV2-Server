/**
 * Additive migration: Join Us door type on businesses.
 *
 * Purpose: Persist restaurant vs local business door after homepage Join Us
 * (Pass A session hint → Pass C durable column). Does not change campaign_status.
 *
 * Inputs: none (uses pool).
 * Outputs: nullable join_door_type on businesses. Existing rows stay NULL.
 *
 * Changelog: Pass C1 — three-door post-email flow.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

/**
 * Full DDL (additive only). Safe to re-run:
 * - ADD COLUMN IF NOT EXISTS
 * - DROP CONSTRAINT IF EXISTS then ADD CHECK
 */
export const JOIN_DOOR_TYPE_DDL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS join_door_type VARCHAR(20) NULL;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_join_door_type_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_join_door_type_check
  CHECK (join_door_type IS NULL OR join_door_type IN ('restaurant', 'local'));

COMMENT ON COLUMN businesses.join_door_type IS
  'Pass C: Join Us door — restaurant | local. Null for legacy rows.';
`;

/**
 * Apply join_door_type column + check constraint.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateJoinDoorType(options: DbTaskOptions = {}) {
  await pool.query(JOIN_DOOR_TYPE_DDL);
  console.log(
    "ForkUp join_door_type applied on businesses (restaurant | local | NULL).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateJoinDoorType().catch((err) => {
    console.error("join_door_type migration failed:", err);
    process.exit(1);
  });
}
