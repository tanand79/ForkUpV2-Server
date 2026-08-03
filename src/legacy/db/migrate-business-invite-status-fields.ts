/**
 * Additive migration: business invite status field alignment.
 *
 * Extends business_invitations to match the full invite status list and
 * tracking fields (message, proposed terms/giveback, acceptance/decline,
 * setup/marketing/settlement readiness). Also adds message_to_business and
 * proposed_terms on campaign_business_locations.
 *
 * Inputs: none (DDL only).
 * Outputs: nullable/defaulted columns; existing rows stay valid; 'sent' retained.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const BUSINESS_INVITE_STATUS_FIELDS_DDL = `
ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS message_to_business TEXT;

ALTER TABLE campaign_business_locations
  ADD COLUMN IF NOT EXISTS proposed_terms TEXT;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS business_id INTEGER;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS proposed_giveback_percentage DECIMAL(5,2);

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS proposed_terms TEXT;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS message_to_business TEXT;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS decline_reason TEXT;

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS setup_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE business_invitations
  DROP CONSTRAINT IF EXISTS bi_setup_status_check;

ALTER TABLE business_invitations
  ADD CONSTRAINT bi_setup_status_check
  CHECK (setup_status IN ('pending', 'needs_info', 'ready', 'complete'));

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS marketing_ready_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE business_invitations
  DROP CONSTRAINT IF EXISTS bi_marketing_ready_status_check;

ALTER TABLE business_invitations
  ADD CONSTRAINT bi_marketing_ready_status_check
  CHECK (marketing_ready_status IN ('pending', 'ready', 'blocked'));

ALTER TABLE business_invitations
  ADD COLUMN IF NOT EXISTS settlement_ready_status VARCHAR(30) NOT NULL DEFAULT 'pending';

ALTER TABLE business_invitations
  DROP CONSTRAINT IF EXISTS bi_settlement_ready_status_check;

ALTER TABLE business_invitations
  ADD CONSTRAINT bi_settlement_ready_status_check
  CHECK (settlement_ready_status IN ('pending', 'needs_info', 'ready'));

ALTER TABLE business_invitations
  DROP CONSTRAINT IF EXISTS business_invitations_invitation_status_check;

ALTER TABLE business_invitations
  ADD CONSTRAINT business_invitations_invitation_status_check
  CHECK (invitation_status IN (
    'draft', 'sent', 'invited', 'opened', 'accepted', 'declined',
    'expired', 'needs_info', 'ready', 'live', 'completed'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_bi_business'
  ) THEN
    ALTER TABLE business_invitations
      ADD CONSTRAINT fk_bi_business
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_invitations_business_id
  ON business_invitations(business_id);

CREATE INDEX IF NOT EXISTS idx_business_invitations_status
  ON business_invitations(invitation_status);
`;

export async function migrateBusinessInviteStatusFields(options: DbTaskOptions = {}) {
  await pool.query(BUSINESS_INVITE_STATUS_FIELDS_DDL);
  console.log(
    "ForkUp business invite status fields applied (message, proposed terms, readiness, extended BI statuses).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateBusinessInviteStatusFields().catch((err) => {
    console.error("Business invite status fields migration failed:", err);
    process.exit(1);
  });
}
