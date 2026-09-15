/**
 * Run Stripe donations migration against production RDS.
 * Usage: npm run db:stripe-donations:production
 *
 * Additive only: stripe_checkout_session_id / stripe_payment_intent_id on donations.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateStripeDonations } from "./migrate-stripe-donations";

migrateStripeDonations().catch((err) => {
  console.error("Production Stripe donations migration failed:", err);
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
