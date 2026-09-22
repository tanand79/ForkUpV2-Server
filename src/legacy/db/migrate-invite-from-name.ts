/**
 * Additive migration — custom invite/lifecycle From display name.
 *
 * Purpose: Persist an editable From display name for invite + lifecycle emails
 * (same idea as email_templates.default_from_name). SMTP From address unchanged.
 * Reply-To continues to use invite_sender_user_id / org contact when set.
 *
 * Inputs: none (uses pool).
 * Outputs: campaigns.invite_from_name VARCHAR(255) NULL.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS invite_from_name VARCHAR(255) NULL;
`;

/**
 * Applies invite_from_name on campaigns.
 * Inputs: options.closePool — when false, leave pool open for chaining.
 * Outputs: nullable column; logs confirmation.
 */
export async function migrateInviteFromName(options: DbTaskOptions = {}) {
  await pool.query(DDL);
  console.log(
    "ForkUp campaigns.invite_from_name applied (nullable display name).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateInviteFromName().catch((err) => {
    console.error("invite_from_name migration failed:", err);
    process.exit(1);
  });
}
