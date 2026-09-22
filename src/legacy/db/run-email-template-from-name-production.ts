/**
 * Run email_templates.default_from_name migration against production RDS.
 * Usage: npm run db:email-template-from-name:production
 *
 * Additive only: ADD COLUMN IF NOT EXISTS default_from_name.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateEmailTemplateFromName } from "./migrate-email-template-from-name";

migrateEmailTemplateFromName().catch((err) => {
  console.error("Production email template from-name migration failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("no pg_hba.conf")
  ) {
    console.error(
      "\nTip: RDS must allow inbound 5432 from this host (security group) or run this on the EC2/API server.",
    );
  }
  process.exit(1);
});
