/**
 * Run businesses.mission migration against production RDS.
 * Usage: npx tsx src/legacy/db/run-business-mission-production.ts
 *
 * Additive only: businesses.mission TEXT NULL.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateBusinessMission } from "./migrate-business-mission";

migrateBusinessMission().catch((err) => {
  console.error("Production businesses.mission migration failed:", err);
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
