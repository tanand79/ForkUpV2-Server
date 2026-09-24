import { pool } from "./pool";

async function main() {
  const r = await pool.query(
    `SELECT id, business_name, website,
            venue_gallery_urls IS NOT NULL AS has_gallery,
            CASE
              WHEN venue_gallery_urls IS NULL THEN 0
              WHEN jsonb_typeof(venue_gallery_urls) = 'array'
                THEN jsonb_array_length(venue_gallery_urls)
              ELSE 0
            END AS n
     FROM businesses
     WHERE business_name ILIKE '%pear%' OR business_name ILIKE '%sovana%'
     ORDER BY id`,
  );
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
