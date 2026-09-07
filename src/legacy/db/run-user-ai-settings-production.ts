/**
 * Run users.ai_bedrock_model migration against production RDS.
 * Usage: npm run db:user-ai-settings:production
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import { migrateUserAiSettings } from "./migrate-user-ai-settings";

migrateUserAiSettings().catch((err) => {
  console.error("Production user AI settings migration failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED") || msg.includes("no pg_hba.conf")) {
    console.error(
      "\nTip: RDS must allow inbound 5432 from this host (security group) or run this on the EC2/API server.",
    );
  }
  process.exit(1);
});
