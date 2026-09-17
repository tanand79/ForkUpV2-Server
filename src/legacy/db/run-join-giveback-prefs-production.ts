/**
 * Run join giveback prefs migration against production RDS (forkupv2).
 * Usage: npx tsx src/legacy/db/run-join-giveback-prefs-production.ts
 *
 * Additive only: businesses.join_giveback_mode, join_cause_mode, join_preferred_campaign_slug.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateJoinGivebackPrefs } from "./migrate-join-giveback-prefs";

migrateJoinGivebackPrefs().catch((err) => {
  console.error("Production join giveback prefs migration failed:", err);
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
