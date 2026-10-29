/**
 * Additive: businesses.mission TEXT for evidence-only Mission copy from public sites.
 *
 * Purpose: Parity with nonprofits.mission — store Mission only when found on the
 * website/social evidence. Never invent dummy text; leave NULL when absent.
 * Inputs: none. Outputs: nullable TEXT column when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS mission TEXT NULL;
`;

export async function migrateBusinessMission(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log("ForkUp businesses.mission column applied (nullable).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateBusinessMission().catch((err) => {
    console.error("businesses.mission migration failed:", err);
    process.exit(1);
  });
}
