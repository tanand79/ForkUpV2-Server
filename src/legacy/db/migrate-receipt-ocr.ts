/**
 * Additive migration: Mindee-compatible OCR fields on receipts.
 *
 * Purpose: store real OCR extract results in the Node stack (no .NET wiring).
 * Does not modify existing columns/constraints (ocr_status, subtotal, etc.).
 *
 * Inputs: none (DDL only).
 * Outputs: nullable/defaulted columns on receipts; existing rows stay valid.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const RECEIPT_OCR_DDL = `
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_provider VARCHAR(40);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_processed_at TIMESTAMP;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_extract_status VARCHAR(20) NOT NULL DEFAULT 'pending';

ALTER TABLE receipts
  DROP CONSTRAINT IF EXISTS receipts_ocr_extract_status_check;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_ocr_extract_status_check
  CHECK (ocr_extract_status IN ('pending', 'completed', 'failed', 'manual_only'));

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_merchant_name VARCHAR(255);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_receipt_number VARCHAR(100);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_date_string VARCHAR(64);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_time_string VARCHAR(64);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_receipt_date TIMESTAMP;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_total DECIMAL(10,2);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_tax DECIMAL(10,2);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_total_line_items DECIMAL(10,2);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_extracted_json JSONB;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_message TEXT;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS is_manual_subtotal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_receipts_ocr_extract_status
  ON receipts(ocr_extract_status);

CREATE INDEX IF NOT EXISTS idx_receipts_ocr_provider
  ON receipts(ocr_provider);
`;

export async function migrateReceiptOcr(options: DbTaskOptions = {}) {
  await pool.query(RECEIPT_OCR_DDL);
  console.log(
    "ForkUp receipt OCR fields applied (provider, extract status, Mindee payload columns).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateReceiptOcr().catch((err) => {
    console.error("Receipt OCR migration failed:", err);
    process.exit(1);
  });
}
