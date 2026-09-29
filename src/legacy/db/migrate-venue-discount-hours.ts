/**
 * Additive: businesses.venue_discount_hours + venue_eligible_window.
 *
 * Purpose: Durable giveback hours / eligible window so venue profile does not
 * depend on browser localStorage (local vs live parity).
 * Inputs: none. Outputs: nullable JSONB + VARCHAR columns when missing.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS venue_discount_hours JSONB NULL,
  ADD COLUMN IF NOT EXISTS venue_eligible_window VARCHAR(255) NULL;
`;

export async function migrateVenueDiscountHours(options: DbTaskOptions = {}) {
  await pool.query(SQL);
  console.log(
    "ForkUp businesses.venue_discount_hours + venue_eligible_window applied (nullable).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateVenueDiscountHours().catch((err) => {
    console.error("venue_discount_hours migration failed:", err);
    process.exit(1);
  });
}
