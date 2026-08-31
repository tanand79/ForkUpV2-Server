/**
 * Wipe all local dev data (users, org links, campaigns) and re-seed demo data.
 * Refuses to run against production.
 *
 * After wipe: seed showcase orgs/campaigns, then recreate platform superadmin
 * (users table is fully cleared — same as a fresh `db:setup` ending).
 */
import type { PoolClient, QueryResultRow } from "pg";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { config } from "../config";
import { pool } from "./pool";
import { seed } from "./seed";
import { migrateSuperadmin } from "./migrate-superadmin";

/**
 * Tables included in a local-only PostgreSQL reset.
 * Child tables first so FK deletes succeed. Newer feature tables are listed so
 * `db:reset` after migrate-* scripts does not leave orphans or block deletes.
 */
const LOCAL_RESET_TABLES = [
  "email_log",
  "automation_runs",
  "payouts",
  "settlement_audit_log",
  "password_reset_tokens",
  "auth_sessions",
  "organization_users",
  "organization_access_requests",
  "organization_library_items",
  "organization_ai_campaign_ideas",
  "organization_ai_analysis_sessions",
  "organization_imports",
  "campaign_ai_insights",
  "campaign_images",
  "donations",
  "business_invitations",
  "nonprofit_campaign_invitations",
  "fundraiser_campaign_invitations",
  "campaign_fundraisers",
  "success_engine_actions",
  "settlements",
  "receipts",
  "participation_intents",
  "campaign_participants",
  "business_acceptances",
  "invitation_tokens",
  "campaign_business_locations",
  "campaign_methods",
  "campaigns",
  "supporters",
  "business_locations",
  "businesses",
  "nonprofits",
  "users",
];

async function wipeLocalTables(connection: PoolClient) {
  const { rows } = await connection.query<QueryResultRow>(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
    [LOCAL_RESET_TABLES],
  );
  const existing = new Set(rows.map((row) => String(row.tablename)));
  const tables = LOCAL_RESET_TABLES.filter((table) => existing.has(table));
  for (const table of tables) {
    await connection.query(`DELETE FROM ${table}`);
  }
}

export async function resetLocal(options: DbTaskOptions = {}) {
  if (config.databaseTarget === "production") {
    throw new Error(
      "refusing to reset — DATABASE_TARGET is production. Set DATABASE_TARGET=local in api/.env",
    );
  }

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    console.log("Wiping local database tables…");
    await wipeLocalTables(connection);
    await connection.query("COMMIT");
    console.log("Local database wiped.");
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }

  await seed({ closePool: false, force: true });
  // Users were wiped — recreate platform superadmin (same as db:setup).
  await migrateSuperadmin({ closePool: false });

  if (options.closePool !== false) {
    await pool.end();
  }
  console.log("\nLocal reset complete. Clear browser storage before signing in again:");
  console.log("  DevTools → Application → Local Storage → localhost:3000 → Clear");
  console.log("  (The web app also clears stale auth automatically on next 401.)");
}

if (isDirectRun(import.meta.url)) {
  resetLocal().catch((err) => {
    console.error("Local reset failed:", err);
    process.exit(1);
  });
}
