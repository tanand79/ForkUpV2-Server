/**
 * Additive migration: latitude / longitude for nearby (~8 mile) filtering.
 *
 * Purpose: Store browser-GPS–compatible coordinates so nonprofit org search and
 * builder business invite lists can filter by distance.
 *
 * Tables:
 * - nonprofits (Find Your Organization)
 * - business_locations (Choose / Invite Businesses)
 *
 * Inputs: none (DDL only).
 * Outputs: nullable latitude/longitude columns + partial indexes.
 * Existing rows remain valid (NULL coords until backfill / Pass 2).
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const GEO_COORDINATES_DDL = `
ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION NULL;

ALTER TABLE nonprofits
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION NULL;

CREATE INDEX IF NOT EXISTS idx_nonprofits_lat_lng
  ON nonprofits (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION NULL;

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION NULL;

CREATE INDEX IF NOT EXISTS idx_business_locations_lat_lng
  ON business_locations (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
`;

/**
 * Apply nullable lat/lng columns for nonprofit and business-location geo filters.
 *
 * Inputs: options.closePool — whether to end the pool (default true when run directly).
 * Outputs: void; logs success; does not alter existing column types or data.
 */
export async function migrateGeoCoordinates(options: DbTaskOptions = {}) {
  await pool.query(GEO_COORDINATES_DDL);
  console.log(
    "ForkUp geo coordinates applied (nonprofits + business_locations latitude/longitude).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateGeoCoordinates().catch((err) => {
    console.error("geo coordinates migration failed:", err);
    process.exit(1);
  });
}
