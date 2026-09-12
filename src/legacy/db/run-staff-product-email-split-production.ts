/**
 * Run staff/product email split migration against production RDS.
 * Usage: npm run db:staff-product-email-split:production
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateStaffProductEmailSplit } from "./migrate-staff-product-email-split";

migrateStaffProductEmailSplit().catch((err) => {
  console.error("Production staff/product email split migration failed:", err);
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
