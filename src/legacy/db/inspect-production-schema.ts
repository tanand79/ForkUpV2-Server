/**
 * READ-ONLY production schema inspector.
 *
 * Connects to the production database and prints every table with its columns.
 * Runs only SELECT statements against information_schema — it never writes,
 * alters, or drops anything. Safe to run against production.
 *
 * Usage (on a host that can reach the RDS instance, e.g. the EC2 server):
 *   cd Forkup-Server
 *   npx tsx src/legacy/db/inspect-production-schema.ts
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function run() {
  const { config } = await import("../config");
  const { pool } = await import("./pool");

  const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Inspecting (read-only) production database`);
  console.log(`Connection: ${safeUrl}\n`);

  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
     ORDER BY table_name, ordinal_position`,
  );

  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name)!.push(r.column_name);
  }

  const out: Record<string, string[]> = {};
  for (const [table, cols] of byTable) out[table] = cols;

  console.log("=== TABLES + COLUMNS (JSON) ===");
  console.log(JSON.stringify(out, null, 2));
  console.log("\n=== TABLE LIST ===");
  console.log([...byTable.keys()].sort().join("\n"));

  await pool.end();
}

run().catch((err) => {
  console.error("Inspection failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
