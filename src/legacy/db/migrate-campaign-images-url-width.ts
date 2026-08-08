/**
 * Additive migration: widen campaign_images.image_url and source_url to VARCHAR(2048).
 * Purpose: Instagram/Facebook CDN URLs with signed query strings often exceed 512.
 *
 * Inputs: none (uses pool).
 * Outputs: campaign_images.image_url and source_url typed as VARCHAR(2048). Existing rows unchanged.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const CAMPAIGN_IMAGES_URL_WIDTH_DDL = `
ALTER TABLE campaign_images
  ALTER COLUMN image_url TYPE VARCHAR(2048),
  ALTER COLUMN source_url TYPE VARCHAR(2048);
`;

export async function migrateCampaignImagesUrlWidth(
  options: DbTaskOptions = {},
) {
  await pool.query(CAMPAIGN_IMAGES_URL_WIDTH_DDL);
  console.log(
    "ForkUp campaign_images.image_url and source_url widened to VARCHAR(2048).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateCampaignImagesUrlWidth().catch((err) => {
    console.error("campaign_images URL width migration failed:", err);
    process.exit(1);
  });
}
