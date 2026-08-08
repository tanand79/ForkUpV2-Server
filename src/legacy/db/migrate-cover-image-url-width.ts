/**
 * Additive migration: widen campaigns.cover_image_url from VARCHAR(512) to VARCHAR(2048).
 * Purpose: allow Instagram/Facebook CDN image URLs (signed query strings often exceed 512).
 *
 * Inputs: none (uses pool).
 * Outputs: campaigns.cover_image_url typed as VARCHAR(2048). Existing rows unchanged.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const COVER_IMAGE_URL_WIDTH_DDL = `
ALTER TABLE campaigns
  ALTER COLUMN cover_image_url TYPE VARCHAR(2048);
`;

export async function migrateCoverImageUrlWidth(
  options: DbTaskOptions = {},
) {
  await pool.query(COVER_IMAGE_URL_WIDTH_DDL);
  console.log(
    "ForkUp campaigns.cover_image_url widened to VARCHAR(2048).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateCoverImageUrlWidth().catch((err) => {
    console.error("cover_image_url width migration failed:", err);
    process.exit(1);
  });
}
