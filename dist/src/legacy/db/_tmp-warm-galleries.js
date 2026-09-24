"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("./pool");
const business_venue_images_1 = require("../lib/business-venue-images");
const persist_business_public_links_1 = require("../lib/persist-business-public-links");
async function main() {
    const r = await pool_1.pool.query(`SELECT id, business_name, website
     FROM businesses
     WHERE website IS NOT NULL
       AND trim(website) <> ''
       AND (
         venue_gallery_urls IS NULL
         OR jsonb_typeof(venue_gallery_urls) <> 'array'
         OR jsonb_array_length(venue_gallery_urls) = 0
       )
     ORDER BY id`);
    console.log(`Warming gallery for ${r.rows.length} business(es)…`);
    for (const row of r.rows) {
        const started = Date.now();
        try {
            const urls = await (0, business_venue_images_1.scrapeBusinessVenueImages)({
                websiteUrl: row.website,
                limit: 16,
            });
            if (urls.length > 0) {
                await (0, persist_business_public_links_1.persistBusinessGalleryUrls)(row.id, urls);
            }
            console.log(`  #${row.id} ${row.business_name}: ${urls.length} photos in ${Date.now() - started}ms`);
        }
        catch (err) {
            console.error(`  #${row.id} ${row.business_name} failed:`, err);
        }
    }
    await pool_1.pool.end();
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=_tmp-warm-galleries.js.map