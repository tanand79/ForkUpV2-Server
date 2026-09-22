/**
 * Run campaigns.invite_sender_user_id migration against production RDS.
 * Usage: npm run db:invite-sender-user:production
 *
 * Additive only: nullable FK column + index on campaigns.
 * Sets env BEFORE importing pool/config (dynamic import).
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config.js");
  const safe = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Production invite_sender_user_id → ${config.databaseTarget} ${safe}`);
  const { migrateInviteSenderUser } = await import("./migrate-invite-sender-user.js");
  await migrateInviteSenderUser();
}

main().catch((err) => {
  console.error("Production invite-sender-user migration failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("no pg_hba.conf")
  ) {
    console.error(
      "\nTip: run this on the EC2/API server (RDS security group), not from a blocked laptop IP.",
    );
  }
  process.exit(1);
});
