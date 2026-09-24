/**
 * Additive: businesses.venue_cover_url for durable venue profile cover photo.
 *
 * Purpose: Let a business pick a cover among scraped + uploaded gallery images.
 * Inputs: none. Outputs: nullable VARCHAR column when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS venue_cover_url VARCHAR(2048) NULL;
`;

export async function migrateVenueCoverUrl(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log("ForkUp businesses.venue_cover_url column applied (nullable).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateVenueCoverUrl().catch((err) => {
    console.error("venue_cover_url migration failed:", err);
    process.exit(1);
  });
}
