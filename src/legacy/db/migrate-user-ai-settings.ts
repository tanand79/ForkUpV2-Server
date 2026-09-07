/**
 * Additive migration: per-user Bedrock model preference on users.
 * Run: npm run db:user-ai-settings
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [table, column],
  );
  return (rowCount ?? 0) > 0;
}

export async function migrateUserAiSettings(options: DbTaskOptions = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await columnExists("users", "ai_bedrock_model"))) {
      await client.query(`ALTER TABLE users ADD COLUMN ai_bedrock_model VARCHAR(200) NULL`);
      console.log("Added users.ai_bedrock_model");
    }
    await client.query("COMMIT");
    console.log("User AI settings migration applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    if (options.closePool !== false) {
      await pool.end();
    }
  }
}

if (isDirectRun(import.meta.url)) {
  migrateUserAiSettings().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
