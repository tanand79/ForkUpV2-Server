/**
 * Additive: nonprofits.gallery_urls + cover_url for org profile photos.
 *
 * Purpose: NPO profile gallery (like businesses.venue_gallery_urls).
 * Inputs: none. Outputs: nullable JSONB + cover URL columns when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS gallery_urls JSONB NULL;

ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS cover_url VARCHAR(2048) NULL;
`;

export async function migrateNonprofitGallery(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log(
    "ForkUp nonprofits.gallery_urls + cover_url columns applied (nullable).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateNonprofitGallery().catch((err) => {
    console.error("nonprofit gallery migration failed:", err);
    process.exit(1);
  });
}
