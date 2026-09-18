/**
 * Additive migration — campaign invite sender person (From display name / Reply-To).
 *
 * Purpose: Persist which organization member was chosen as the email sender so
 * deferred NPO→business invites and later lifecycle emails keep the same From.
 * SMTP From address remains Super Admin smtp_from; this stores users.id only.
 *
 * Inputs: none (uses pool).
 * Outputs: campaigns.invite_sender_user_id (nullable FK → users, ON DELETE SET NULL).
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const INVITE_SENDER_USER_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS invite_sender_user_id INTEGER NULL;

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS fk_campaigns_invite_sender_user;

ALTER TABLE campaigns
  ADD CONSTRAINT fk_campaigns_invite_sender_user
    FOREIGN KEY (invite_sender_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_invite_sender_user_id
  ON campaigns (invite_sender_user_id)
  WHERE invite_sender_user_id IS NOT NULL;
`;

/**
 * Applies invite_sender_user_id on campaigns.
 * Inputs: options.closePool — when false, leave pool open for chaining.
 * Outputs: column + FK + partial index; logs confirmation.
 */
export async function migrateInviteSenderUser(options: DbTaskOptions = {}) {
  await pool.query(INVITE_SENDER_USER_DDL);
  console.log(
    "ForkUp campaigns.invite_sender_user_id applied (nullable FK → users).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateInviteSenderUser().catch((err) => {
    console.error("invite_sender_user migration failed:", err);
    process.exit(1);
  });
}
