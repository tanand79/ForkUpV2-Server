/**
 * Additive migration: optional featured YouTube video URL on campaigns.
 * Purpose: store a watch/shorts URL for hero media (plays first when set).
 *
 * Inputs: none (uses pool).
 * Outputs: campaigns.featured_youtube_url VARCHAR(512) NULL.
 * Existing rows unchanged (NULL = no video). Does not alter cover_image_url.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const FEATURED_YOUTUBE_URL_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS featured_youtube_url VARCHAR(512) NULL;
`;

/**
 * Applies the featured_youtube_url column migration.
 * Inputs: options.closePool — when false, leave pool open for chaining.
 * Outputs: column present on campaigns; logs confirmation.
 */
export async function migrateFeaturedYoutubeUrl(
  options: DbTaskOptions = {},
) {
  await pool.query(FEATURED_YOUTUBE_URL_DDL);
  console.log(
    "ForkUp campaigns.featured_youtube_url column applied (nullable).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateFeaturedYoutubeUrl().catch((err) => {
    console.error("featured_youtube_url migration failed:", err);
    process.exit(1);
  });
}
