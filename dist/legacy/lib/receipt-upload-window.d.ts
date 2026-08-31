export type ReceiptWindowCampaign = {
    campaign_status: string;
    campaign_end_date: Date | string | null;
    settlement_grace_days: number | null;
    settlement_frozen_at: Date | string | null;
    adjustment_window_end: Date | string | null;
};
export declare function receiptUploadBlockedReason(campaign: ReceiptWindowCampaign, now?: Date): string | null;
