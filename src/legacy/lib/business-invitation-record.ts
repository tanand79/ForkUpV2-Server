/**
 * Business invitation ledger helpers.
 *
 * Purpose: Keep business_invitations aligned with campaign_business_locations
 * for per-invite status and tracking fields without duplicating SQL at call sites.
 *
 * Inputs: PoolClient + invite field bag.
 * Outputs: INSERT/UPDATE side effects; no return payload.
 */
import type { PoolClient } from "pg";

export type BusinessInvitationInsertInput = {
  campaignId: number;
  nonprofitId: number;
  methodId: number;
  businessId: number;
  businessName: string;
  businessEmail: string;
  campaignBusinessLocationId: number;
  respondByDate: string | null;
  invitedByUserId?: number | null;
  proposedGivebackPercentage: number;
  messageToBusiness?: string | null;
  proposedTerms?: string | null;
};

/**
 * Inserts one business_invitations ledger row for a newly created partner invite.
 * Status is always 'invited' (legacy 'sent' remains valid for older rows).
 */
export async function insertBusinessInvitationRecord(
  connection: PoolClient,
  input: BusinessInvitationInsertInput,
): Promise<void> {
  await connection.query(
    `INSERT INTO business_invitations (
      campaign_id, nonprofit_id, method_id, business_id,
      business_name, business_email, invitation_status,
      campaign_business_location_id, respond_by_date, invited_by_user_id,
      proposed_giveback_percentage, message_to_business, proposed_terms,
      setup_status
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, 'invited',
      $7, $8, $9,
      $10, $11, $12,
      'pending'
    )`,
    [
      input.campaignId,
      input.nonprofitId,
      input.methodId,
      input.businessId,
      input.businessName,
      input.businessEmail,
      input.campaignBusinessLocationId,
      input.respondByDate,
      input.invitedByUserId ?? null,
      input.proposedGivebackPercentage,
      input.messageToBusiness?.trim() || null,
      input.proposedTerms?.trim() || null,
    ],
  );
}

/**
 * Syncs business_invitations after accept (status + readiness + accepted_at).
 */
export async function syncBusinessInvitationAccepted(
  connection: PoolClient,
  input: {
    campaignBusinessLocationId: number;
    invitationStatus: "needs_info" | "ready";
    setupStatus: string;
    marketingReadyStatus: string;
    settlementReadyStatus: string;
  },
): Promise<void> {
  await connection.query(
    `UPDATE business_invitations SET
       invitation_status = $2,
       accepted_at = NOW(),
       responded_at = NOW(),
       setup_status = $3,
       marketing_ready_status = $4,
       settlement_ready_status = $5
     WHERE campaign_business_location_id = $1`,
    [
      input.campaignBusinessLocationId,
      input.invitationStatus,
      input.setupStatus,
      input.marketingReadyStatus,
      input.settlementReadyStatus,
    ],
  );
}

/**
 * Syncs business_invitations after decline.
 */
export async function syncBusinessInvitationDeclined(
  connection: PoolClient,
  input: {
    campaignBusinessLocationId: number;
    declineReason?: string | null;
  },
): Promise<void> {
  await connection.query(
    `UPDATE business_invitations SET
       invitation_status = 'declined',
       decline_reason = $2,
       responded_at = NOW()
     WHERE campaign_business_location_id = $1`,
    [input.campaignBusinessLocationId, input.declineReason ?? null],
  );
}

/**
 * Maps CBL changes_requested → BI needs_info for linked invitation rows.
 */
export async function syncBusinessInvitationNeedsInfo(
  connection: PoolClient,
  campaignBusinessLocationIds: number[],
): Promise<void> {
  if (campaignBusinessLocationIds.length === 0) return;
  await connection.query(
    `UPDATE business_invitations SET
       invitation_status = 'needs_info',
       responded_at = COALESCE(responded_at, NOW())
     WHERE campaign_business_location_id = ANY($1::int[])`,
    [campaignBusinessLocationIds],
  );
}
