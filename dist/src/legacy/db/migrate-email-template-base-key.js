"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateEmailTemplateBaseKey = migrateEmailTemplateBaseKey;
const cli_1 = require("./cli");
const pool_1 = require("./pool");
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
async function migrateEmailTemplateBaseKey(options = {}) {
    await pool_1.pool.query(DDL);
    console.log("ForkUp email_templates.base_template_key applied (nullable + backfill + index).");
    if (options.closePool !== false) {
        await pool_1.pool.end();
    }
}
if ((0, cli_1.isDirectRun)(import.meta.url)) {
    migrateEmailTemplateBaseKey().catch((err) => {
        console.error("email template base-key migration failed:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=migrate-email-template-base-key.js.map