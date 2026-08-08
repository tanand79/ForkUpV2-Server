/**
 * Additive migration: widen email_log.related_token from VARCHAR(64) to VARCHAR(512).
 * Purpose: allow dedupe keys that include campaign slugs or recipient emails
 * (e.g. `forkup-approve-${slug}`, `success-action:${id}:${email}`) without overflow.
 *
 * Inputs: none (uses pool).
 * Outputs: email_log.related_token typed as VARCHAR(512). Existing rows unchanged.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const RELATED_TOKEN_WIDTH_DDL = `
ALTER TABLE email_log
  ALTER COLUMN related_token TYPE VARCHAR(512);
`;

export async function migrateEmailRelatedTokenWidth(
  options: DbTaskOptions = {},
) {
  await pool.query(RELATED_TOKEN_WIDTH_DDL);
  console.log(
    "ForkUp email_log.related_token widened to VARCHAR(512).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateEmailRelatedTokenWidth().catch((err) => {
    console.error("email_log related_token width migration failed:", err);
    process.exit(1);
  });
}
