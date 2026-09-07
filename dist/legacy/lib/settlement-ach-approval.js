"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSettlementAchApproval = ensureSettlementAchApproval;
exports.settlementAchApprovalUrl = settlementAchApprovalUrl;
exports.loadSettlementAchApproval = loadSettlementAchApproval;
exports.approveSettlementAch = approveSettlementAch;
const crypto_1 = __importDefault(require("crypto"));
const pool_1 = require("../db/pool");
async function ensureSettlementAchApproval(params) {
    const { rows } = await pool_1.pool.query(`SELECT approval_token FROM settlement_ach_approvals
     WHERE settlement_id = $1 AND approval_type = $2`, [params.settlementId, params.approvalType]);
    if (rows[0]?.approval_token) {
        return String(rows[0].approval_token);
    }
    const token = crypto_1.default.randomBytes(32).toString("hex");
    await pool_1.pool.query(`INSERT INTO settlement_ach_approvals
       (settlement_id, campaign_id, approval_type, amount, approval_token)
     VALUES ($1, $2, $3, $4, $5)`, [
        params.settlementId,
        params.campaignId,
        params.approvalType,
        Math.round(params.amount * 100) / 100,
        token,
    ]);
    return token;
}
function settlementAchApprovalUrl(token, baseUrl) {
    return `${baseUrl}/?step=settlement-ach-approval&token=${encodeURIComponent(token)}`;
}
async function loadSettlementAchApproval(token) {
    const { rows } = await pool_1.pool.query(`SELECT a.approval_token, a.approval_type, a.amount, a.status,
            a.approved_at, a.approved_by_name,
            c.campaign_name, n.organization_name,
            b.business_name, bl.location_name
     FROM settlement_ach_approvals a
     JOIN campaigns c ON c.id = a.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN settlements s ON s.id = a.settlement_id
     LEFT JOIN businesses b ON b.id = s.business_id
     LEFT JOIN business_locations bl ON bl.id = s.location_id
     WHERE a.approval_token = $1`, [token.trim()]);
    const row = rows[0];
    if (!row)
        return null;
    return {
        token: String(row.approval_token),
        approvalType: row.approval_type,
        amount: Number(row.amount ?? 0),
        status: row.status,
        campaignName: String(row.campaign_name ?? ""),
        organizationName: String(row.organization_name ?? ""),
        businessName: row.business_name != null ? String(row.business_name) : null,
        locationName: row.location_name != null ? String(row.location_name) : null,
        approvedAt: row.approved_at != null ? String(row.approved_at) : null,
        approvedByName: row.approved_by_name != null ? String(row.approved_by_name) : null,
    };
}
async function approveSettlementAch(token, approvedByName, approvedByEmail) {
    const existing = await loadSettlementAchApproval(token);
    if (!existing)
        return null;
    if (existing.status === "approved")
        return existing;
    await pool_1.pool.query(`UPDATE settlement_ach_approvals SET
       status = 'approved',
       approved_by_name = $1,
       approved_by_email = $2,
       approved_at = NOW(),
       ach_initiated_at = NOW()
     WHERE approval_token = $3 AND status = 'pending'`, [approvedByName.trim(), approvedByEmail.trim().toLowerCase(), token.trim()]);
    const { rows } = await pool_1.pool.query(`SELECT settlement_id, approval_type FROM settlement_ach_approvals WHERE approval_token = $1`, [token.trim()]);
    const settlementId = Number(rows[0]?.settlement_id);
    const approvalType = rows[0]?.approval_type;
    if (settlementId > 0) {
        await pool_1.pool.query(`UPDATE settlements SET ach_status = 'processing' WHERE id = $1`, [settlementId]);
        await pool_1.pool.query(`INSERT INTO settlement_audit_log (campaign_id, settlement_id, action, details, performed_by)
       SELECT campaign_id, $1, $2, $3, $4 FROM settlement_ach_approvals WHERE approval_token = $5`, [
            settlementId,
            approvalType === "nonprofit_payout" ? "NONPROFIT_ACH_APPROVED" : "BUSINESS_ACH_APPROVED",
            `ACH approved by ${approvedByName} (${approvedByEmail})`,
            approvedByEmail,
            token.trim(),
        ]);
    }
    return loadSettlementAchApproval(token);
}
//# sourceMappingURL=settlement-ach-approval.js.map