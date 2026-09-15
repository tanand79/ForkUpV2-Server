/**
 * One-off check: are Stripe donation columns present on the configured DB?
 * Usage: DATABASE_TARGET=production NODE_ENV=production npx tsx src/legacy/db/check-stripe-donations-columns.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.DATABASE_TARGET = process.env.DATABASE_TARGET || "production";

import { pool } from "./pool";

async function main() {
  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'donations'
       AND column_name IN ('stripe_checkout_session_id', 'stripe_payment_intent_id')
     ORDER BY column_name`,
  );
  const idx = await pool.query<{ indexname: string }>(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'donations'
       AND indexname = 'idx_donations_stripe_session'`,
  );

  console.log("databaseTarget:", process.env.DATABASE_TARGET);
  console.log(
    "columns:",
    cols.rows.map((r) => r.column_name).join(", ") || "(none)",
  );
  console.log(
    "index:",
    idx.rows.map((r) => r.indexname).join(", ") || "(none)",
  );
  const ok = cols.rows.length === 2 && idx.rows.length === 1;
  console.log("applied:", ok ? "yes" : "no");
  await pool.end();
  process.exit(ok ? 0 : 2);
}

main().catch(async (err) => {
  console.error("check failed:", err instanceof Error ? err.message : err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
