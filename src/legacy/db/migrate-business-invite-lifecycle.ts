/**
 * Additive migration: business invite lifecycle (Nick V2 Layer 3).
 *
 * Adds respond_by / opened / invited_by / setup-marketing-settlement readiness
 * on campaign_business_locations and business_invitations, and extends status
 * CHECK lists without removing existing values.
 *
 * Inputs: none (DDL only).
 * Outputs: schema columns applied; existing rows get safe defaults.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const INVITE_LIFECYCLE_DDL = `
ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS respond_by_date DATE;

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS invited_by_user_id INTEGER;

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS setup_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE campaign_business_locations
  DROP CONSTRAINT IF EXISTS cbl_setup_status_check;

ALTER TABLE campaign_business_locations
  ADD CONSTRAINT cbl_setup_status_check
  CHECK (setup_status IN ('pending', 'needs_info', 'ready', 'complete'));

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS marketing_ready_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE campaign_business_locations
  DROP CONSTRAINT IF EXISTS cbl_marketing_ready_status_check;

ALTER TABLE campaign_business_locations
  ADD CONSTRAINT cbl_marketing_ready_status_check
  CHECK (marketing_ready_status IN ('pending', 'ready', 'blocked'));

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS settlement_ready_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE campaign_business_locations
  DROP CONSTRAINT IF EXISTS cbl_settlement_ready_status_check;

ALTER TABLE campaign_business_locations
  ADD CONSTRAINT cbl_settlement_ready_status_check
  CHECK (settlement_ready_status IN ('pending', 'needs_info', 'ready'));

ALTER TABLE campaign_business_locations
  DROP CONSTRAINT IF EXISTS campaign_business_locations_invite_status_check;

ALTER TABLE campaign_business_locations
  ADD CONSTRAINT campaign_business_locations_invite_status_check
  CHECK (invite_status IN (
    'draft', 'invited', 'opened', 'pending', 'accepted', 'declined',
    'changes_requested', 'needs_info', 'ready', 'expired', 'live', 'completed'
  ));

ALTER TABLE campaign_business_locations
  DROP CONSTRAINT IF EXISTS campaign_business_locations_acceptance_status_check;

ALTER TABLE campaign_business_locations
  ADD CONSTRAINT campaign_business_locations_acceptance_status_check
  CHECK (acceptance_status IN (
    'draft', 'invited', 'opened', 'pending', 'accepted', 'declined',
    'changes_requested', 'needs_info', 'ready', 'expired', 'live', 'completed'
  ));

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS respond_by_date DATE;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS invited_by_user_id INTEGER;

ALTER TABLE business_invitations
  DROP CONSTRAINT IF EXISTS business_invitations_invitation_status_check;

ALTER TABLE business_invitations
  ADD CONSTRAINT business_invitations_invitation_status_check
  CHECK (invitation_status IN (
    'draft', 'sent', 'opened', 'accepted', 'declined', 'expired', 'needs_info'
  ));
`;

export async function migrateBusinessInviteLifecycle(options: DbTaskOptions = {}) {
  await pool.query(INVITE_LIFECYCLE_DDL);
  console.log(
    "ForkUp business invite lifecycle schema applied (respond_by, opened_at, readiness, extended statuses).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateBusinessInviteLifecycle().catch((err) => {
    console.error("Business invite lifecycle migration failed:", err);
    process.exit(1);
  });
}
