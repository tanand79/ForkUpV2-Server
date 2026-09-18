/**
 * Run campaign partner join-requests migration against production RDS.
 * Usage: npx tsx src/legacy/db/run-campaign-partner-join-requests-production.ts
 *
 * Additive only: CREATE TABLE campaign_partner_join_requests + indexes.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateCampaignPartnerJoinRequests } from "./migrate-campaign-partner-join-requests";

migrateCampaignPartnerJoinRequests().catch((err) => {
  console.error(
    "Production campaign partner join requests migration failed:",
    err,
  );
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
