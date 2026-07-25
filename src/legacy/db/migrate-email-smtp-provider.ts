/**
 * Additive migration: allow email_log.provider = 'smtp'
 * (Super Admin Brevo/SMTP path). Does not alter existing rows or columns.
 *
 * Inputs: none (uses pool).
 * Outputs: updated CHECK constraint on email_log.provider.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SMTP_PROVIDER_DDL = `
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_provider_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_provider_check
  CHECK (provider IN ('ses', 'noop', 'smtp'));
`;

export async function migrateEmailSmtpProvider(options: DbTaskOptions = {}) {
  await pool.query(SMTP_PROVIDER_DDL);
  console.log("ForkUp email_log provider CHECK extended (ses, noop, smtp).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateEmailSmtpProvider().catch((err) => {
    console.error("email_log smtp provider migration failed:", err);
    process.exit(1);
  });
}
