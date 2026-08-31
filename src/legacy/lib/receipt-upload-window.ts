import { settlementEngineSettings } from "./settlement-engine";

export type ReceiptWindowCampaign = {
  campaign_status: string;
  campaign_end_date: Date | string | null;
  settlement_grace_days: number | null;
  settlement_frozen_at: Date | string | null;
  adjustment_window_end: Date | string | null;
};

/**
 * Receipts are allowed through end date + grace, and during the 24h adjustment
 * window after close. Frozen campaigns are closed for new uploads.
 */
export function receiptUploadBlockedReason(
  campaign: ReceiptWindowCampaign,
  now = new Date(),
): string | null {
  if (campaign.settlement_frozen_at) {
    return "This campaign is frozen for settlement. New receipts are not accepted.";
  }

  const status = String(campaign.campaign_status);
  if (!["live", "ready_to_launch", "closed"].includes(status)) {
    return "Campaign not found or not accepting receipts";
  }

  if (!campaign.campaign_end_date) return null;

  const settings = settlementEngineSettings();
  const graceDays = Number(campaign.settlement_grace_days ?? settings.gracePeriodDays);
  const end = new Date(campaign.campaign_end_date);
  if (Number.isNaN(end.getTime())) return null;
  const graceEnd = new Date(
    end.getTime() + Math.max(graceDays, 0) * 24 * 60 * 60 * 1000,
  );
  if (now.getTime() <= graceEnd.getTime()) return null;

  const adjustmentEnd = campaign.adjustment_window_end
    ? new Date(campaign.adjustment_window_end)
    : null;
  if (
    status === "closed" &&
    adjustmentEnd &&
    !Number.isNaN(adjustmentEnd.getTime()) &&
    now.getTime() <= adjustmentEnd.getTime()
  ) {
    return null;
  }

  return "The receipt window has closed (campaign end date plus grace period).";
}
