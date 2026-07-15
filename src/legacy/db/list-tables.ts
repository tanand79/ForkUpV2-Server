import type { QueryResultRow } from "pg";
import { pool } from "./pool";

async function main() {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = current_schema()
     ORDER BY tablename`,
  );
  const names = rows.map((row) => String(row.tablename));
  console.log(`Table count: ${names.length}`);
  for (const name of names) console.log(`  - ${name}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
