/**
 * Additive migration — base_template_key for multi-person email template variants.
 *
 * Purpose: Allow multiple stored templates per system email type, matched at
 * send time by default_from_name (e.g. Anand vs Supraja). template_key stays
 * unique per row; base_template_key points at the system catalog key.
 *
 * Inputs: none (uses pool).
 * Outputs: email_templates.base_template_key + backfill + index.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const DDL = `
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS base_template_key VARCHAR(60) NULL;

UPDATE email_templates
SET base_template_key = template_key
WHERE base_template_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_templates_base_from
  ON email_templates (
    scope_type,
    scope_id,
    base_template_key,
    lower(default_from_name)
  )
  WHERE is_active = TRUE AND default_from_name IS NOT NULL;
`;

/**
 * Applies base_template_key on email_templates and backfills existing rows.
 * Inputs: options.closePool — when false, leave pool open for chaining.
 * Outputs: nullable column + index; logs confirmation.
 */
export async function migrateEmailTemplateBaseKey(
  options: DbTaskOptions = {},
) {
  await pool.query(DDL);
  console.log(
    "ForkUp email_templates.base_template_key applied (nullable + backfill + index).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateEmailTemplateBaseKey().catch((err) => {
    console.error("email template base-key migration failed:", err);
    process.exit(1);
  });
}
