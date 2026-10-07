/**
 * Additive migration: guest nonprofit claim tokens on nonprofits.
 *
 * Purpose: Lock guest NPO Join drafts to the first contact email and
 * email a manage/claim link (mirrors businesses.guest_claim_*).
 *
 * Inputs: none (uses pool).
 * Outputs: nullable guest_claim_* columns on nonprofits. Existing rows unchanged.
 *
 * Changelog: Guest nonprofit draft lock + claim email.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const GUEST_NONPROFIT_CLAIM_DDL = `
ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS guest_claim_email VARCHAR(255) NULL;

ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS guest_claim_token VARCHAR(64) NULL;

ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS guest_claim_expires_at TIMESTAMP NULL;

ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS guest_claim_claimed_at TIMESTAMP NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nonprofits_guest_claim_token
  ON nonprofits (guest_claim_token)
  WHERE guest_claim_token IS NOT NULL;
`;

/**
 * Apply guest nonprofit claim columns.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateGuestNonprofitClaim(options: DbTaskOptions = {}) {
  await pool.query(GUEST_NONPROFIT_CLAIM_DDL);
  console.log(
    "ForkUp guest nonprofit claim columns applied (guest_claim_email/token/expires/claimed_at).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateGuestNonprofitClaim().catch((err) => {
    console.error("guest nonprofit claim migration failed:", err);
    process.exit(1);
  });
}
