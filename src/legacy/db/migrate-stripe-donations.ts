/**
 * Additive migration: Stripe Checkout identifiers on donations.
 *
 * Purpose: Support real card payments for online (virtual) donations.
 * Pending rows are created at checkout start; webhook marks completed.
 *
 * Inputs: none (uses pool).
 * Outputs: nullable stripe_checkout_session_id / stripe_payment_intent_id
 *          on donations. Existing rows unchanged.
 *
 * Changelog: Pass 1 — Stripe online donation integration.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const STRIPE_DONATIONS_DDL = `
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255) NULL;

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_stripe_session
  ON donations (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
`;

/**
 * Apply Stripe donation columns.
 * Inputs: options.closePool — end pool when run directly (default true).
 * Outputs: void; additive only.
 */
export async function migrateStripeDonations(options: DbTaskOptions = {}) {
  await pool.query(STRIPE_DONATIONS_DDL);
  console.log(
    "ForkUp Stripe donation columns applied (stripe_checkout_session_id, stripe_payment_intent_id).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateStripeDonations().catch((err) => {
    console.error("stripe donations migration failed:", err);
    process.exit(1);
  });
}
