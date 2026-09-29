/**
 * One-shot production repair: rename Sovanabistro → Sovana Bistro and fill
 * placeholder location fields (City Name / State Name) with real Kennett Square details.
 *
 * Run on a host that can reach RDS (e.g. EC2):
 *   cd Forkup-Server
 *   npx tsx src/legacy/db/repair-sovana-name-location-production.ts
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config.js");
  const { pool } = await import("./pool.js");
  console.log("TARGET", config.databaseTarget);
  console.log("URL", config.databaseUrl.replace(/:([^:@/]+)@/, ":****@"));

  const beforeBiz = await pool.query(
    `SELECT id, business_name, slug, website
     FROM businesses
     WHERE business_name ILIKE '%sovana%' OR slug ILIKE '%sovana%'
     ORDER BY id`,
  );
  console.log("BEFORE businesses", JSON.stringify(beforeBiz.rows, null, 2));

  if (beforeBiz.rows.length === 0) {
    console.log("No Sovana business found — aborting with no writes.");
    await pool.end();
    return;
  }

  const ids = beforeBiz.rows.map((r: { id: number }) => r.id);
  const beforeLoc = await pool.query(
    `SELECT id, business_id, location_name, address, city, state, zip, phone,
            website_url, reservation_url
     FROM business_locations
     WHERE business_id = ANY($1::int[])
     ORDER BY business_id, id`,
    [ids],
  );
  console.log("BEFORE locations", JSON.stringify(beforeLoc.rows, null, 2));

  const renamed = await pool.query(
    `UPDATE businesses
     SET business_name = 'Sovana Bistro',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::int[])
     RETURNING id, business_name, slug`,
    [ids],
  );
  console.log("UPDATED businesses", JSON.stringify(renamed.rows, null, 2));

  const filled = await pool.query(
    `UPDATE business_locations bl
     SET location_name = 'Main Location',
         address = '696 Unionville Rd',
         city = 'Kennett Square',
         state = 'PA',
         zip = '19348',
         phone = '(610) 444-5600',
         website_url = COALESCE(NULLIF(btrim(bl.website_url), ''), 'https://www.sovanabistro.com'),
         reservation_url = COALESCE(
           NULLIF(btrim(bl.reservation_url), ''),
           'https://resy.com/cities/kennett-square-pa/venues/sovana-bistro'
         ),
         updated_at = CURRENT_TIMESTAMP
     WHERE bl.business_id = ANY($1::int[])
     RETURNING bl.id, bl.business_id, bl.location_name, bl.address, bl.city, bl.state, bl.zip, bl.phone,
               bl.website_url, bl.reservation_url`,
    [ids],
  );
  console.log("UPDATED locations", JSON.stringify(filled.rows, null, 2));
  console.log("business rowCount", renamed.rowCount, "location rowCount", filled.rowCount);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
