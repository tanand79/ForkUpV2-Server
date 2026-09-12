/**
 * Additive migration: guest launch claim tokens on campaigns.
 *
 * Purpose: Allow launch-before-signup. Guest provides email at launch; we store
 * a one-time claim token so they can claim ownership later (any device via email).
 *
 * Inputs: none (uses pool).
 * Outputs: nullable guest_claim_* columns on campaigns. Existing rows unchanged.
 *
 * Changelog: Pass 2 — guest launch without signup wall.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const GUEST_CLAIM_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS guest_claim_email VARCHAR(255) NULL;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS guest_claim_token VARCHAR(64) NULL;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS guest_claim_expires_at TIMESTAMP NULL;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS guest_claim_claimed_at TIMESTAMP NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_guest_claim_token
  ON campaigns (guest_claim_token)
  WHERE guest_claim_token IS NOT NULL;
`;

/**
 * Apply guest campaign claim columns.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateGuestCampaignClaim(options: DbTaskOptions = {}) {
  await pool.query(GUEST_CLAIM_DDL);
  console.log(
    "ForkUp guest campaign claim columns applied (guest_claim_email/token/expires/claimed_at).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateGuestCampaignClaim().catch((err) => {
    console.error("guest campaign claim migration failed:", err);
    process.exit(1);
  });
}
