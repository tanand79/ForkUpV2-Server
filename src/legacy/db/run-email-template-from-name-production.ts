/**
 * Run email_templates.default_from_name migration against production RDS.
 * Usage: npm run db:email-template-from-name:production
 *
 * Additive only: ADD COLUMN IF NOT EXISTS default_from_name.
 * Sets env BEFORE importing pool/config (dynamic import).
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config.js");
  const safe = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Production default_from_name → ${config.databaseTarget} ${safe}`);
  const { migrateEmailTemplateFromName } = await import(
    "./migrate-email-template-from-name.js"
  );
  await migrateEmailTemplateFromName();
}

main().catch((err) => {
  console.error("Production email template from-name migration failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("no pg_hba.conf")
  ) {
    console.error(
      "\nTip: run this on the EC2/API server (RDS security group), not from a blocked laptop IP.",
    );
  }
  process.exit(1);
});
