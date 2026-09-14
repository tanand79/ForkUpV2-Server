"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertBusinessInvitationRecord = insertBusinessInvitationRecord;
exports.syncBusinessInvitationAccepted = syncBusinessInvitationAccepted;
exports.syncBusinessInvitationDeclined = syncBusinessInvitationDeclined;
exports.syncBusinessInvitationNeedsInfo = syncBusinessInvitationNeedsInfo;
async function insertBusinessInvitationRecord(connection, input) {
    await connection.query(`INSERT INTO business_invitations (
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
    )`, [
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
    ]);
}
async function syncBusinessInvitationAccepted(connection, input) {
    await connection.query(`UPDATE business_invitations SET
       invitation_status = $2,
       accepted_at = NOW(),
       responded_at = NOW(),
       setup_status = $3,
       marketing_ready_status = $4,
       settlement_ready_status = $5
     WHERE campaign_business_location_id = $1`, [
        input.campaignBusinessLocationId,
        input.invitationStatus,
        input.setupStatus,
        input.marketingReadyStatus,
        input.settlementReadyStatus,
    ]);
}
async function syncBusinessInvitationDeclined(connection, input) {
    await connection.query(`UPDATE business_invitations SET
       invitation_status = 'declined',
       decline_reason = $2,
       responded_at = NOW()
     WHERE campaign_business_location_id = $1`, [input.campaignBusinessLocationId, input.declineReason ?? null]);
}
async function syncBusinessInvitationNeedsInfo(connection, campaignBusinessLocationIds) {
    if (campaignBusinessLocationIds.length === 0)
        return;
    await connection.query(`UPDATE business_invitations SET
       invitation_status = 'needs_info',
       responded_at = COALESCE(responded_at, NOW())
     WHERE campaign_business_location_id = ANY($1::int[])`, [campaignBusinessLocationIds]);
}
//# sourceMappingURL=business-invitation-record.js.map