/**
 * Additive migration — editable From display name on email templates.
 *
 * Purpose: Persist a custom From display name (not the email address).
 * Reply-To still uses default_sender_user_id; SMTP From stays smtp_from.
 *
 * Inputs: none (uses pool).
 * Outputs: email_templates.default_from_name VARCHAR(255) NULL.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const DDL = `
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS default_from_name VARCHAR(255) NULL;
`;

/**
 * Applies default_from_name on email_templates.
 * Inputs: options.closePool — when false, leave pool open for chaining.
 * Outputs: nullable column; logs confirmation.
 */
export async function migrateEmailTemplateFromName(
  options: DbTaskOptions = {},
) {
  await pool.query(DDL);
  console.log(
    "ForkUp email_templates.default_from_name applied (nullable).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateEmailTemplateFromName().catch((err) => {
    console.error("email template from-name migration failed:", err);
    process.exit(1);
  });
}
