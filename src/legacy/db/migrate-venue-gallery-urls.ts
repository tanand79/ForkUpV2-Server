/**
 * Additive: businesses.venue_gallery_urls JSONB for cached public venue photos.
 *
 * Purpose: Profile gallery opens from DB instead of re-scraping every time.
 * Inputs: none. Outputs: nullable JSONB array column when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS venue_gallery_urls JSONB NULL;
`;

export async function migrateVenueGalleryUrls(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log("ForkUp businesses.venue_gallery_urls column applied (nullable).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateVenueGalleryUrls().catch((err) => {
    console.error("venue_gallery_urls migration failed:", err);
    process.exit(1);
  });
}
