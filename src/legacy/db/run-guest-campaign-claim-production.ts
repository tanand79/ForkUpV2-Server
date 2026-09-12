/**
 * Run guest campaign claim migration against production RDS.
 * Usage: npm run db:guest-campaign-claim:production
 *
 * Additive only: guest_claim_* columns on campaigns.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateGuestCampaignClaim } from "./migrate-guest-campaign-claim";

migrateGuestCampaignClaim().catch((err) => {
  console.error("Production guest campaign claim migration failed:", err);
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
