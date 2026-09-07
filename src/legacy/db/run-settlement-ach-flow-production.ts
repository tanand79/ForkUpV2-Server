/**
 * Run nonprofit ACH + settlement_ach_approvals migration against production RDS.
 * Usage: npm run db:settlement-ach-flow:production
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function run() {
  const { config } = await import("../config");
  const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Database target: ${config.databaseTarget}`);
  console.log(`Connection: ${safeUrl}`);

  const { migrateSettlementAchFlow } = await import("./migrate-settlement-ach-flow");
  await migrateSettlementAchFlow();
}

run().catch((err) => {
  console.error("Production settlement ACH flow migration failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED") || msg.includes("no pg_hba.conf")) {
    console.error(
      "\nTip: RDS must allow inbound 5432 from this host (security group) or run this on the EC2/API server.",
    );
  }
  process.exit(1);
});
