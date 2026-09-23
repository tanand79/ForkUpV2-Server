/**
 * Fill empty Sovana / Pear reservation_url on production RDS.
 * Usage: npx tsx src/legacy/db/run-backfill-known-booking-urls-production.ts
 *
 * Only updates rows where reservation_url is null or blank.
 * Does not overwrite an existing URL.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config");
  const { backfillKnownBookingUrls } = await import("./backfill-known-booking-urls");
  console.log("TARGET", config.databaseTarget);
  console.log("URL", config.databaseUrl.replace(/:([^:@/]+)@/, ":****@"));
  await backfillKnownBookingUrls({ closePool: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
