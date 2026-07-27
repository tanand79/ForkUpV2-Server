/**
 * Wipe campaign-related rows, non-seed org profiles, and non-superadmin sign-in data.
 * Purpose: free emails/names for re-registration; keep superadmin, platform_settings, and seed orgs.
 * Inputs: none (uses pool / DATABASE_TARGET).
 * Output: console summary of deleted row counts; refuses production unless ALLOW_PRODUCTION_WIPE=1.
 *
 * Seed orgs kept (from seed.ts):
 *   nonprofits: bayside-animal-rescue, greenleaf-food-bank
 *   businesses: olive-and-oak, harbor-coffee, farm-table
 *
 * Run local:  $env:DATABASE_TARGET='local'; npx tsx src/legacy/db/wipe-campaign-signin.ts
 * Run prod:   $env:DATABASE_TARGET='production'; $env:ALLOW_PRODUCTION_WIPE='1'; npx tsx src/legacy/db/wipe-campaign-signin.ts
 */
import type { PoolClient, QueryResultRow } from "pg";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { config } from "../config";
import { pool } from "./pool";

/** Known demo seed slugs from seed.ts — never delete these org rows. */
const SEED_NONPROFIT_SLUGS = ["bayside-animal-rescue", "greenleaf-food-bank"];
const SEED_BUSINESS_SLUGS = ["olive-and-oak", "harbor-coffee", "farm-table"];

/** Child → parent order for campaign / invite / money tables (all rows). */
const CAMPAIGN_TABLES = [
  "donations",
  "settlements",
  "receipts",
  "participation_intents",
  "campaign_participants",
  "success_engine_actions",
  "business_acceptances",
  "invitation_tokens",
  "campaign_business_locations",
  "business_invitations",
  "nonprofit_campaign_invitations",
  "payouts",
  "automation_runs",
  "campaign_methods",
  "campaigns",
  "supporters",
  "organization_access_requests",
  "organization_library_items",
  "organization_imports",
];

async function tableExists(connection: PoolClient, table: string): Promise<boolean> {
  const { rowCount } = await connection.query(
    `SELECT 1
     FROM pg_tables
     WHERE schemaname = current_schema() AND tablename = $1`,
    [table],
  );
  return (rowCount ?? 0) > 0;
}

async function deleteAll(connection: PoolClient, table: string): Promise<number> {
  if (!(await tableExists(connection, table))) {
    console.log(`  skip ${table} (missing)`);
    return 0;
  }
  const result = await connection.query(`DELETE FROM ${table}`);
  const count = result.rowCount ?? 0;
  console.log(`  ${table}: ${count} row(s)`);
  return count;
}

export async function wipeCampaignAndSignin(options: DbTaskOptions = {}) {
  const allowProd = (process.env.ALLOW_PRODUCTION_WIPE ?? "").trim() === "1";
  if (config.databaseTarget === "production" && !allowProd) {
    throw new Error(
      "Refusing production wipe. Set ALLOW_PRODUCTION_WIPE=1 and DATABASE_TARGET=production only after explicit approval.",
    );
  }

  console.log(`Target: ${config.databaseTarget}`);
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    console.log("Campaign-related tables…");
    for (const table of CAMPAIGN_TABLES) {
      await deleteAll(connection, table);
    }

    console.log("Org profiles (keep seed slugs)…");
    if (await tableExists(connection, "business_locations")) {
      const r = await connection.query(
        `DELETE FROM business_locations
         WHERE business_id IN (
           SELECT id FROM businesses WHERE slug <> ALL($1::text[])
         )`,
        [SEED_BUSINESS_SLUGS],
      );
      console.log(`  business_locations (non-seed): ${r.rowCount ?? 0} row(s)`);
    }

    if (await tableExists(connection, "businesses")) {
      const r = await connection.query(
        `DELETE FROM businesses WHERE slug <> ALL($1::text[])`,
        [SEED_BUSINESS_SLUGS],
      );
      console.log(`  businesses (non-seed): ${r.rowCount ?? 0} row(s)`);
    }

    if (await tableExists(connection, "nonprofits")) {
      const r = await connection.query(
        `DELETE FROM nonprofits WHERE slug <> ALL($1::text[])`,
        [SEED_NONPROFIT_SLUGS],
      );
      console.log(`  nonprofits (non-seed): ${r.rowCount ?? 0} row(s)`);
    }

    console.log("Sign-in data (keep is_platform_admin = TRUE)…");
    if (await tableExists(connection, "auth_sessions")) {
      const r = await connection.query(
        `DELETE FROM auth_sessions
         WHERE user_id NOT IN (SELECT id FROM users WHERE is_platform_admin = TRUE)`,
      );
      console.log(`  auth_sessions: ${r.rowCount ?? 0} row(s)`);
    }

    if (await tableExists(connection, "password_reset_tokens")) {
      const r = await connection.query(
        `DELETE FROM password_reset_tokens
         WHERE user_id NOT IN (SELECT id FROM users WHERE is_platform_admin = TRUE)`,
      );
      console.log(`  password_reset_tokens: ${r.rowCount ?? 0} row(s)`);
    }

    if (await tableExists(connection, "organization_users")) {
      const r = await connection.query(`DELETE FROM organization_users`);
      console.log(`  organization_users: ${r.rowCount ?? 0} row(s)`);
    }

    const usersResult = await connection.query(
      `DELETE FROM users WHERE is_platform_admin IS NOT TRUE`,
    );
    console.log(`  users (non-superadmin): ${usersResult.rowCount ?? 0} row(s)`);

    const { rows: kept } = await connection.query<QueryResultRow>(
      `SELECT id, email, username, is_platform_admin
       FROM users
       WHERE is_platform_admin = TRUE`,
    );
    console.log(`Kept superadmin user(s): ${kept.length}`);
    for (const row of kept) {
      console.log(`  id=${row.id} email=${row.email} username=${row.username ?? ""}`);
    }

    const { rows: keptNp } = await connection.query<QueryResultRow>(
      `SELECT id, slug FROM nonprofits ORDER BY id`,
    );
    console.log(`Kept nonprofit(s): ${keptNp.length}`);
    for (const row of keptNp) {
      console.log(`  id=${row.id} slug=${row.slug}`);
    }

    const { rows: keptBiz } = await connection.query<QueryResultRow>(
      `SELECT id, slug FROM businesses ORDER BY id`,
    );
    console.log(`Kept business(es): ${keptBiz.length}`);
    for (const row of keptBiz) {
      console.log(`  id=${row.id} slug=${row.slug}`);
    }

    await connection.query("COMMIT");
    console.log("Wipe complete. Schema unchanged. Seed orgs preserved.");
    console.log("Tip: run seed afterward to restore showcase campaigns if needed.");
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
    if (options.closePool !== false) {
      await pool.end();
    }
  }
}

if (isDirectRun(import.meta.url)) {
  wipeCampaignAndSignin().catch((err) => {
    console.error("Wipe failed:", err);
    process.exit(1);
  });
}
