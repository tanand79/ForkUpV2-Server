/**
 * Push the ForkUp schema (STRUCTURE ONLY) to the production PostgreSQL database (AWS RDS).
 *
 * What this does:
 *   - Applies schema-postgresql.sql, which is fully additive:
 *     CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / idempotent triggers.
 *   - Creates any missing tables, indexes, and triggers on RDS.
 *
 * What this does NOT do (on purpose):
 *   - Does NOT copy any rows from your local database.
 *   - Does NOT seed demo/sample data (that is `npm run db:seed`).
 *   - Does NOT drop, rename, or alter existing tables/columns or delete data.
 *
 * Manual usage from your local machine (Windows PowerShell), run inside Forkup-Server:
 *
 *   1) Set the RDS connection URL for this terminal (once per terminal):
 *        $env:DATABASE_URL_PRODUCTION="postgresql://USER:URL_ENCODED_PASSWORD@RDS_ENDPOINT:5432/forkup?ssl=true"
 *
 *   2) Preview without changing anything (recommended first):
 *        npm run db:push-rds:schema:dry
 *
 *   3) Apply for real:
 *        npm run db:push-rds:schema
 *
 * The `:dry` variant runs everything inside a transaction and then ROLLS BACK,
 * so it is safe to run against RDS to confirm the connection + SQL are valid and
 * to see exactly which tables would be created.
 */

// Force production target BEFORE importing config/pool (they read these at import time).
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDry = process.argv.includes("--dry");

async function listTableNames(
  query: (text: string) => Promise<{ rows: { table_name: string }[] }>,
): Promise<Set<string>> {
  const { rows } = await query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((r) => r.table_name));
}

async function run() {
  // Imported dynamically so the env vars above are already set when config initializes.
  const { config } = await import("../config");
  const { pool } = await import("./pool");

  const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Mode:        ${isDry ? "DRY RUN (rollback, no changes saved)" : "APPLY (changes saved)"}`);
  console.log(`DB target:   ${config.databaseTarget}`);
  console.log(`Connection:  ${safeUrl}`);
  console.log("");

  const schema = fs.readFileSync(path.join(__dirname, "schema-postgresql.sql"), "utf-8");

  const client = await pool.connect();
  try {
    const before = await listTableNames((text) => client.query(text));

    await client.query("BEGIN");
    // PostgreSQL parses the full dollar-quoted PL/pgSQL script itself.
    await client.query(schema);

    const after = await listTableNames((text) => client.query(text));
    const created = [...after].filter((t) => !before.has(t)).sort();

    if (isDry) {
      await client.query("ROLLBACK");
      console.log(
        created.length > 0
          ? `Would CREATE ${created.length} table(s): ${created.join(", ")}`
          : "No new tables — RDS schema already matches (nothing would change).",
      );
      console.log("\nDry run complete. Nothing was saved to RDS.");
    } else {
      await client.query("COMMIT");
      console.log(
        created.length > 0
          ? `Created ${created.length} table(s): ${created.join(", ")}`
          : "No new tables — RDS schema already up to date.",
      );
      console.log("\nSchema push complete.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("\nRDS schema push failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("password authentication failed") ||
    msg.includes("no pg_hba.conf entry") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("timeout")
  ) {
    console.error(
      "\nTip: check DATABASE_URL_PRODUCTION (host, URL-encoded password, ?ssl=true) and that the\n" +
        "RDS security group allows inbound 5432 from your current IP.",
    );
  }
  process.exit(1);
});
