/**
 * Run email_templates table migration against production RDS.
 * Usage: npm run db:email-templates:production
 *
 * Additive only: CREATE TABLE IF NOT EXISTS email_templates + indexes.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateEmailTemplates } from "./migrate-email-templates";

migrateEmailTemplates().catch((err) => {
  console.error("Production email_templates migration failed:", err);
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
