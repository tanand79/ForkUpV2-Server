/**
 * Additive migration: guest business claim tokens on businesses.
 *
 * Purpose: Lock guest restaurant/local drafts to the first contact email and
 * email a manage/claim link (mirrors campaigns.guest_claim_*).
 *
 * Inputs: none (uses pool).
 * Outputs: nullable guest_claim_* columns on businesses. Existing rows unchanged.
 *
 * Changelog: Guest business draft lock + claim email.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const GUEST_BUSINESS_CLAIM_DDL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS guest_claim_email VARCHAR(255) NULL;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS guest_claim_token VARCHAR(64) NULL;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS guest_claim_expires_at TIMESTAMP NULL;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS guest_claim_claimed_at TIMESTAMP NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_guest_claim_token
  ON businesses (guest_claim_token)
  WHERE guest_claim_token IS NOT NULL;
`;

/**
 * Apply guest business claim columns.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateGuestBusinessClaim(options: DbTaskOptions = {}) {
  await pool.query(GUEST_BUSINESS_CLAIM_DDL);
  console.log(
    "ForkUp guest business claim columns applied (guest_claim_email/token/expires/claimed_at).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateGuestBusinessClaim().catch((err) => {
    console.error("guest business claim migration failed:", err);
    process.exit(1);
  });
}
