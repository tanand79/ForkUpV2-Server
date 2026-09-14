export type AchApprovalType = "business_debit" | "nonprofit_payout";
export type AchApprovalStatus = "pending" | "approved" | "rejected";
export declare function ensureSettlementAchApproval(params: {
    settlementId: number;
    campaignId: number;
    approvalType: AchApprovalType;
    amount: number;
}): Promise<string>;
export declare function settlementAchApprovalUrl(token: string, baseUrl: string): string;
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
export declare function loadSettlementAchApproval(token: string): Promise<SettlementAchApprovalView | null>;
export declare function approveSettlementAch(token: string, approvedByName: string, approvedByEmail: string): Promise<SettlementAchApprovalView | null>;
