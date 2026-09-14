/**
 * Run join_door_type migration against production RDS.
 * Usage: npx tsx src/legacy/db/run-join-door-type-production.ts
 *
 * Additive only: businesses.join_door_type (restaurant | local | NULL).
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateJoinDoorType } from "./migrate-join-door-type";

migrateJoinDoorType().catch((err) => {
  console.error("Production join_door_type migration failed:", err);
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
