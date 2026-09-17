"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.DATABASE_TARGET = process.env.DATABASE_TARGET || "production";
const pool_1 = require("./pool");
async function main() {
    const cols = await pool_1.pool.query(`SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'donations'
       AND column_name IN ('stripe_checkout_session_id', 'stripe_payment_intent_id')
     ORDER BY column_name`);
    const idx = await pool_1.pool.query(`SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'donations'
       AND indexname = 'idx_donations_stripe_session'`);
    console.log("databaseTarget:", process.env.DATABASE_TARGET);
    console.log("columns:", cols.rows.map((r) => r.column_name).join(", ") || "(none)");
    console.log("index:", idx.rows.map((r) => r.indexname).join(", ") || "(none)");
    const ok = cols.rows.length === 2 && idx.rows.length === 1;
    console.log("applied:", ok ? "yes" : "no");
    await pool_1.pool.end();
    process.exit(ok ? 0 : 2);
}
main().catch(async (err) => {
    console.error("check failed:", err instanceof Error ? err.message : err);
    try {
        await pool_1.pool.end();
    }
    catch {
    }
    process.exit(1);
});
//# sourceMappingURL=check-stripe-donations-columns.js.map