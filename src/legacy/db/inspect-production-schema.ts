/**
 * READ-ONLY production schema inspector.
 *
 * Connects to the production database and prints every table with its columns,
 * every CHECK constraint (with its definition), and any expected tables that are
 * missing. Runs only SELECT statements against the catalog — it never writes,
 * alters, or drops anything. Safe to run against production.
 *
 * Usage (on a host that can reach the RDS instance, e.g. the EC2 server):
 *   cd Forkup-Server
 *   npx tsx src/legacy/db/inspect-production-schema.ts
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

const EXPECTED_TABLES = [
  "auth_sessions",
  "business_acceptances",
  "business_invitations",
  "business_locations",
  "businesses",
  "campaign_business_locations",
  "campaign_methods",
  "campaign_participants",
  "campaigns",
  "donations",
  "email_log",
  "email_templates",
  "invitation_tokens",
  "nonprofit_campaign_invitations",
  "nonprofits",
  "organization_access_requests",
  "organization_imports",
  "organization_users",
  "participation_intents",
  "receipts",
  "settlements",
  "success_engine_actions",
  "supporters",
  "users",
];

async function run() {
  const { config } = await import("../config.js");
  const { pool } = await import("./pool.js");

  const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Inspecting (read-only) production database`);
  console.log(`Connection: ${safeUrl}\n`);

  const colResult = await pool.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = current_schema()
     ORDER BY table_name, ordinal_position`,
  );
  const colRows = colResult.rows as {
    table_name: string;
    column_name: string;
    data_type: string;
  }[];

  const byTable = new Map<string, string[]>();
  for (const r of colRows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name)!.push(r.column_name);
  }

  const out: Record<string, string[]> = {};
  for (const [table, cols] of byTable) out[table] = cols;

  console.log("=== TABLES + COLUMNS (JSON) ===");
  console.log(JSON.stringify(out, null, 2));

  const missingTables = EXPECTED_TABLES.filter((t) => !byTable.has(t));
  console.log("\n=== MISSING TABLES (expected by code, absent in prod) ===");
  console.log(missingTables.length ? missingTables.join("\n") : "(none)");

  const checkResult = await pool.query(
    `SELECT conrelid::regclass::text AS table_name,
            conname AS constraint_name,
            pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE contype = 'c'
       AND connamespace = current_schema()::regnamespace
     ORDER BY conrelid::regclass::text, conname`,
  );
  const checkRows = checkResult.rows as {
    table_name: string;
    constraint_name: string;
    definition: string;
  }[];

  console.log("\n=== CHECK CONSTRAINTS ===");
  for (const c of checkRows) {
    console.log(`${c.table_name}.${c.constraint_name}: ${c.definition}`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Inspection failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
