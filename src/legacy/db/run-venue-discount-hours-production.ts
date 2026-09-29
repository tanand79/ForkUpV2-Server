/**
 * Run venue_discount_hours / venue_eligible_window migration on production RDS.
 * Usage: npm run db:venue-discount-hours:production
 *
 * Prefer EC2 (RDS security group). Additive only: ADD COLUMN IF NOT EXISTS.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config.js");
  const safe = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Production venue_discount_hours → ${config.databaseTarget} ${safe}`);
  const { migrateVenueDiscountHours } = await import(
    "./migrate-venue-discount-hours.js"
  );
  await migrateVenueDiscountHours();
}

main().catch((err) => {
  console.error("Production venue_discount_hours migration failed:", err);
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
