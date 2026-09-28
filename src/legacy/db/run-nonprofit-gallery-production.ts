/**
 * Run nonprofit gallery migration against production RDS.
 * Usage: npx tsx src/legacy/db/run-nonprofit-gallery-production.ts
 *
 * Additive only: nonprofits.gallery_urls JSONB + cover_url VARCHAR.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateNonprofitGallery } from "./migrate-nonprofit-gallery";

migrateNonprofitGallery().catch((err) => {
  console.error("Production nonprofit gallery migration failed:", err);
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
