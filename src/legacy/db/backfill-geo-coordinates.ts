/**
 * Additive backfill: set latitude/longitude from ZIP for rows that have zip but no coords.
 *
 * Purpose: Populate geo columns added by migrate-geo-coordinates.ts using Zippopotam.us
 * so ~8 mile nearby filters can apply to existing seeded/local data.
 *
 * Inputs: none (reads nonprofits + business_locations).
 * Outputs: UPDATE statements for rows successfully geocoded; logs counts.
 *
 * Does not overwrite existing non-null coordinates. Does not delete or alter other columns.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";
import { geocodeUsZip } from "../lib/geo-distance";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill NULL lat/lng from ZIP on nonprofits and business_locations.
 *
 * Inputs: options.closePool — end pool when done (default true for direct run).
 * Outputs: void; console summary of updated / skipped / failed rows.
 */
export async function backfillGeoCoordinates(options: DbTaskOptions = {}) {
  let nonprofitUpdated = 0;
  let nonprofitFailed = 0;
  let locationUpdated = 0;
  let locationFailed = 0;

  const { rows: nonprofits } = await pool.query<{
    id: number;
    zip: string | null;
  }>(
    `SELECT id, zip FROM nonprofits
     WHERE (latitude IS NULL OR longitude IS NULL)
       AND zip IS NOT NULL
       AND TRIM(zip) <> ''
     ORDER BY id`,
  );

  for (const row of nonprofits) {
    const coords = await geocodeUsZip(row.zip ?? "");
    if (!coords) {
      nonprofitFailed += 1;
      await sleep(120);
      continue;
    }
    await pool.query(
      `UPDATE nonprofits
       SET latitude = $1, longitude = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND (latitude IS NULL OR longitude IS NULL)`,
      [coords.latitude, coords.longitude, row.id],
    );
    nonprofitUpdated += 1;
    await sleep(120);
  }

  const { rows: locations } = await pool.query<{
    id: number;
    zip: string | null;
  }>(
    `SELECT id, zip FROM business_locations
     WHERE (latitude IS NULL OR longitude IS NULL)
       AND zip IS NOT NULL
       AND TRIM(zip) <> ''
     ORDER BY id`,
  );

  for (const row of locations) {
    const coords = await geocodeUsZip(row.zip ?? "");
    if (!coords) {
      locationFailed += 1;
      await sleep(120);
      continue;
    }
    await pool.query(
      `UPDATE business_locations
       SET latitude = $1, longitude = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND (latitude IS NULL OR longitude IS NULL)`,
      [coords.latitude, coords.longitude, row.id],
    );
    locationUpdated += 1;
    await sleep(120);
  }

  console.log(
    `Geo backfill complete — nonprofits updated=${nonprofitUpdated} failed=${nonprofitFailed}; ` +
      `business_locations updated=${locationUpdated} failed=${locationFailed}`,
  );

  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  backfillGeoCoordinates().catch((err) => {
    console.error("geo coordinates backfill failed:", err);
    process.exit(1);
  });
}
