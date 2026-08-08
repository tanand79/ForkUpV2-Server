/**
 * Additive migration: encrypted ACH bank / authorization fields on business_locations.
 *
 * Purpose: store ACH routing/account (encrypted at app layer), auth metadata, and
 * signature path in the Node stack (parity with old .NET location ACH — no processor debit).
 *
 * Does not modify existing ach_authorized flags on business_acceptances / CBL.
 *
 * Inputs: none (DDL only).
 * Outputs: nullable/defaulted columns; existing rows stay valid.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const LOCATION_ACH_DDL = `
ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_bank_name VARCHAR(150);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_account_holder_name VARCHAR(150);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_account_type VARCHAR(20);

ALTER TABLE business_locations
  DROP CONSTRAINT IF EXISTS bl_ach_account_type_check;

ALTER TABLE business_locations
  ADD CONSTRAINT bl_ach_account_type_check
  CHECK (ach_account_type IS NULL OR ach_account_type IN ('checking', 'savings'));

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_routing_number VARCHAR(500);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_account_number VARCHAR(500);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_account_last4 VARCHAR(4);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_authorization_status VARCHAR(20) NOT NULL DEFAULT 'pending';

ALTER TABLE business_locations
  DROP CONSTRAINT IF EXISTS bl_ach_authorization_status_check;

ALTER TABLE business_locations
  ADD CONSTRAINT bl_ach_authorization_status_check
  CHECK (ach_authorization_status IN ('pending', 'authorized', 'revoked'));

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_authorized_by VARCHAR(150);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_authorized_email VARCHAR(150);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_authorized_at TIMESTAMP;

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_last_updated_at TIMESTAMP;

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_signature_path VARCHAR(512);

ALTER TABLE business_locations
  ADD COLUMN IF NOT EXISTS ach_contact_email VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_business_locations_ach_status
  ON business_locations(ach_authorization_status);
`;

export async function migrateLocationAch(options: DbTaskOptions = {}) {
  await pool.query(LOCATION_ACH_DDL);
  console.log(
    "ForkUp location ACH fields applied (encrypted bank columns + authorization metadata).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateLocationAch().catch((err) => {
    console.error("Location ACH migration failed:", err);
    process.exit(1);
  });
}
