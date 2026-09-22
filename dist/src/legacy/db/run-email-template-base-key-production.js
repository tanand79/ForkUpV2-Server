"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";
async function main() {
    const { config } = await import("../config.js");
    const safe = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
    console.log(`Production base_template_key → ${config.databaseTarget} ${safe}`);
    const { migrateEmailTemplateBaseKey } = await import("./migrate-email-template-base-key.js");
    await migrateEmailTemplateBaseKey();
}
main().catch((err) => {
    console.error("Production email template base-key migration failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("no pg_hba.conf")) {
        console.error("\nTip: run this on the EC2/API server (RDS security group), not from a blocked laptop IP.");
    }
    process.exit(1);
});
//# sourceMappingURL=run-email-template-base-key-production.js.map