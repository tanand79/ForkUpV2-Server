/**
 * Run guest fundraiser invite migration against production RDS.
 * Usage: npm run db:guest-fundraiser-invite:production
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateGuestFundraiserInvite } from "./migrate-guest-fundraiser-invite";

migrateGuestFundraiserInvite().catch((err) => {
  console.error("Production guest fundraiser invite migration failed:", err);
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
