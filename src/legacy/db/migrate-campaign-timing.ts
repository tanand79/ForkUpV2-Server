/**
 * Additive migration: campaign / method timing status for Nick V2 Layer 2.
 *
 * Adds:
 * - campaigns.event_date (Guest Bartending single event date)
 * - campaigns.business_timing_status (ok | needs_forkup_review | limited_promotion_window)
 * - campaigns.forkup_review_* (short-timeline review workflow)
 * - campaign_methods.timing_status (per-method timing gate)
 *
 * Inputs: none (DDL only).
 * Outputs: schema columns applied; existing rows get safe defaults.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const TIMING_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS event_date DATE;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS business_timing_status VARCHAR(40) NOT NULL DEFAULT 'ok';

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_business_timing_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_business_timing_status_check
  CHECK (business_timing_status IN (
    'ok',
    'needs_forkup_review',
    'limited_promotion_window'
  ));

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS forkup_review_status VARCHAR(30) NOT NULL DEFAULT 'none';

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_forkup_review_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_forkup_review_status_check
  CHECK (forkup_review_status IN ('none', 'pending', 'approved', 'denied'));

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS forkup_review_reason TEXT;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS forkup_review_requested_at TIMESTAMP;

ALTER TABLE campaign_methods
  ADD COLUMN IF NOT EXISTS timing_status VARCHAR(40) NOT NULL DEFAULT 'ok';

ALTER TABLE campaign_methods
  DROP CONSTRAINT IF EXISTS campaign_methods_timing_status_check;

ALTER TABLE campaign_methods
  ADD CONSTRAINT campaign_methods_timing_status_check
  CHECK (timing_status IN (
    'ok',
    'needs_forkup_review',
    'limited_promotion_window'
  ));
`;

export async function migrateCampaignTiming(options: DbTaskOptions = {}) {
  await pool.query(TIMING_DDL);
  console.log(
    "ForkUp campaign timing schema applied (event_date, business_timing_status, forkup_review_*, method timing_status).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateCampaignTiming().catch((err) => {
    console.error("Campaign timing migration failed:", err);
    process.exit(1);
  });
}
