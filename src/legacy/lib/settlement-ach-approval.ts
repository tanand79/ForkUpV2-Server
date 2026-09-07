/**
 * Settlement ACH approval tokens — business debit and nonprofit payout flows.
 *
 * Task 18 — existing ACH in V1 / this codebase:
 * - Business bank details: encrypted on `business_locations` (migrate-location-ach.ts),
 *   GET/POST `/api/business/locations/:id/ach` (location-ach.ts).
 * - Campaign acceptance sets `ach_authorized` on business_acceptances / CBL.
 * - Settlement rows track `ach_status` (pending → processing → paid | failed).
 * - No live processor debit — ACH is submitted manually via bank portal after approval.
 *
 * Task 17 / 20 — this module adds invoice-style approval links so a business or
 * nonprofit can approve a specific settlement amount before ACH is initiated.
 */
import crypto from "crypto";
import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";

export type AchApprovalType = "business_debit" | "nonprofit_payout";
export type AchApprovalStatus = "pending" | "approved" | "rejected";

/**
 * ensureSettlementAchApproval — create or reuse a token for a settlement ACH action.
 * Inputs: settlement id, campaign id, type, amount. Outputs: opaque approval token string.
 */
export async function ensureSettlementAchApproval(params: {
  settlementId: number;
  campaignId: number;
  approvalType: AchApprovalType;
  amount: number;
}): Promise<string> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT approval_token FROM settlement_ach_approvals
     WHERE settlement_id = $1 AND approval_type = $2`,
    [params.settlementId, params.approvalType],
  );
  if (rows[0]?.approval_token) {
    return String(rows[0].approval_token);
  }
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO settlement_ach_approvals
       (settlement_id, campaign_id, approval_type, amount, approval_token)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.settlementId,
      params.campaignId,
      params.approvalType,
      Math.round(params.amount * 100) / 100,
      token,
    ],
  );
  return token;
}

/** Browser URL for the public ACH approval screen. */
export function settlementAchApprovalUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/?step=settlement-ach-approval&token=${encodeURIComponent(token)}`;
}

export type SettlementAchApprovalView = {
  token: string;
  approvalType: AchApprovalType;
  amount: number;
  status: AchApprovalStatus;
  campaignName: string;
  organizationName: string;
  businessName: string | null;
  locationName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
};

/**
 * loadSettlementAchApproval — fetch approval context by token (public, no auth).
 */
export async function loadSettlementAchApproval(
  token: string,
): Promise<SettlementAchApprovalView | null> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT a.approval_token, a.approval_type, a.amount, a.status,
            a.approved_at, a.approved_by_name,
            c.campaign_name, n.organization_name,
            b.business_name, bl.location_name
     FROM settlement_ach_approvals a
     JOIN campaigns c ON c.id = a.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN settlements s ON s.id = a.settlement_id
     LEFT JOIN businesses b ON b.id = s.business_id
     LEFT JOIN business_locations bl ON bl.id = s.location_id
     WHERE a.approval_token = $1`,
    [token.trim()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    token: String(row.approval_token),
    approvalType: row.approval_type as AchApprovalType,
    amount: Number(row.amount ?? 0),
    status: row.status as AchApprovalStatus,
    campaignName: String(row.campaign_name ?? ""),
    organizationName: String(row.organization_name ?? ""),
    businessName: row.business_name != null ? String(row.business_name) : null,
    locationName: row.location_name != null ? String(row.location_name) : null,
    approvedAt: row.approved_at != null ? String(row.approved_at) : null,
    approvedByName: row.approved_by_name != null ? String(row.approved_by_name) : null,
  };
}

/**
 * approveSettlementAch — record approver identity and mark ACH as processing.
 * Inputs: token, approver name/email. Outputs: updated view or null if not found.
 */
export async function approveSettlementAch(
  token: string,
  approvedByName: string,
  approvedByEmail: string,
): Promise<SettlementAchApprovalView | null> {
  const existing = await loadSettlementAchApproval(token);
  if (!existing) return null;
  if (existing.status === "approved") return existing;

  await pool.query(
    `UPDATE settlement_ach_approvals SET
       status = 'approved',
       approved_by_name = $1,
       approved_by_email = $2,
       approved_at = NOW(),
       ach_initiated_at = NOW()
     WHERE approval_token = $3 AND status = 'pending'`,
    [approvedByName.trim(), approvedByEmail.trim().toLowerCase(), token.trim()],
  );

  const { rows } = await pool.query<QueryResultRow>(
    `SELECT settlement_id, approval_type FROM settlement_ach_approvals WHERE approval_token = $1`,
    [token.trim()],
  );
  const settlementId = Number(rows[0]?.settlement_id);
  const approvalType = rows[0]?.approval_type as AchApprovalType | undefined;
  if (settlementId > 0) {
    await pool.query(
      `UPDATE settlements SET ach_status = 'processing' WHERE id = $1`,
      [settlementId],
    );
    await pool.query(
      `INSERT INTO settlement_audit_log (campaign_id, settlement_id, action, details, performed_by)
       SELECT campaign_id, $1, $2, $3, $4 FROM settlement_ach_approvals WHERE approval_token = $5`,
      [
        settlementId,
        approvalType === "nonprofit_payout" ? "NONPROFIT_ACH_APPROVED" : "BUSINESS_ACH_APPROVED",
        `ACH approved by ${approvedByName} (${approvedByEmail})`,
        approvedByEmail,
        token.trim(),
      ],
    );
  }

  return loadSettlementAchApproval(token);
}
