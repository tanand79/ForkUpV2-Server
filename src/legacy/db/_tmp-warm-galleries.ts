/**
 * One-shot: warm businesses.venue_gallery_urls for rows that have a website
 * but an empty gallery. Global — not business-specific.
 */
import { pool } from "./pool";
import { scrapeBusinessVenueImages } from "../lib/business-venue-images";
import { persistBusinessGalleryUrls } from "../lib/persist-business-public-links";

async function main() {
  const r = await pool.query(
    `SELECT id, business_name, website
     FROM businesses
     WHERE website IS NOT NULL
       AND trim(website) <> ''
       AND (
         venue_gallery_urls IS NULL
         OR jsonb_typeof(venue_gallery_urls) <> 'array'
         OR jsonb_array_length(venue_gallery_urls) = 0
       )
     ORDER BY id`,
  );
  console.log(`Warming gallery for ${r.rows.length} business(es)…`);
  for (const row of r.rows as {
    id: number;
    business_name: string;
    website: string;
  }[]) {
    const started = Date.now();
    try {
      const urls = await scrapeBusinessVenueImages({
        websiteUrl: row.website,
        limit: 16,
      });
      if (urls.length > 0) {
        await persistBusinessGalleryUrls(row.id, urls);
      }
      console.log(
        `  #${row.id} ${row.business_name}: ${urls.length} photos in ${Date.now() - started}ms`,
      );
    } catch (err) {
      console.error(`  #${row.id} ${row.business_name} failed:`, err);
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
