import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(options: DbTaskOptions = {}) {
  const schema = fs.readFileSync(path.join(__dirname, "schema-postgresql.sql"), "utf-8");
  // PostgreSQL accepts the full script and must parse dollar-quoted PL/pgSQL blocks itself.
  await pool.query(schema);

  console.log("ForkUp V1 database schema applied.");
  if (options.closePool !== false) {
    await pool.end();
  }
}

function printProductionHelp() {
  if (process.env.DATABASE_TARGET !== "production") return;
  console.error("\n--- Production PostgreSQL connection failed ---");
  console.error("Check DATABASE_URL_PRODUCTION in api/.env (host + encoded password).");
  console.error("Confirm the PostgreSQL host permits connections from this environment.\n");
}

if (isDirectRun(import.meta.url)) {
  migrate().catch((err) => {
    console.error("Migration failed:", err);
    printProductionHelp();
    process.exit(1);
  });
}
