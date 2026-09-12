/**
 * Additive migration: allow guest fundraiser invites (no user id yet).
 *
 * Purpose: Pass 3 — fundraiser can send NPO invite with mandatory email before
 * signup. System emails the claimed nonprofit's contact_email on file.
 *
 * Inputs: none. Outputs: fundraiser_user_id nullable on invitations.
 * Existing rows unchanged.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const DDL = `
ALTER TABLE fundraiser_campaign_invitations
  ALTER COLUMN fundraiser_user_id DROP NOT NULL;
`;

/**
 * Apply nullable fundraiser_user_id for guest invites.
 */
export async function migrateGuestFundraiserInvite(options: DbTaskOptions = {}) {
  await pool.query(DDL);
  console.log(
    "ForkUp guest fundraiser invite applied (fundraiser_user_id nullable).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateGuestFundraiserInvite().catch((err) => {
    console.error("guest fundraiser invite migration failed:", err);
    process.exit(1);
  });
}
