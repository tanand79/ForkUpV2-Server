/**
 * Additive: businesses.venue_email for public mailto (separate from claim contact_email).
 *
 * Purpose: Venue profile Mail icon must not use ops/claim contact_email.
 * Inputs: none. Outputs: nullable VARCHAR column when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS venue_email VARCHAR(512) NULL;
`;

export async function migrateVenueEmail(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log("ForkUp businesses.venue_email column applied (nullable).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateVenueEmail().catch((err) => {
    console.error("venue_email migration failed:", err);
    process.exit(1);
  });
}
