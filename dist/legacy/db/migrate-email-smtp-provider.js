"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateEmailSmtpProvider = migrateEmailSmtpProvider;
const cli_1 = require("./cli");
const pool_1 = require("./pool");
const SMTP_PROVIDER_DDL = `
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_provider_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_provider_check
  CHECK (provider IN ('ses', 'noop', 'smtp'));
`;
async function migrateEmailSmtpProvider(options = {}) {
    await pool_1.pool.query(SMTP_PROVIDER_DDL);
    console.log("ForkUp email_log provider CHECK extended (ses, noop, smtp).");
    if (options.closePool !== false) {
        await pool_1.pool.end();
    }
}
if ((0, cli_1.isDirectRun)(import.meta.url)) {
    migrateEmailSmtpProvider().catch((err) => {
        console.error("email_log smtp provider migration failed:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=migrate-email-smtp-provider.js.map