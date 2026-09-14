"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.receiptUploadBlockedReason = receiptUploadBlockedReason;
const settlement_engine_1 = require("./settlement-engine");
function receiptUploadBlockedReason(campaign, now = new Date()) {
    if (campaign.settlement_frozen_at) {
        return "This campaign is frozen for settlement. New receipts are not accepted.";
    }
    const status = String(campaign.campaign_status);
    if (!["live", "ready_to_launch", "closed"].includes(status)) {
        return "Campaign not found or not accepting receipts";
    }
    if (!campaign.campaign_end_date)
        return null;
    const settings = (0, settlement_engine_1.settlementEngineSettings)();
    const graceDays = Number(campaign.settlement_grace_days ?? settings.gracePeriodDays);
    const end = new Date(campaign.campaign_end_date);
    if (Number.isNaN(end.getTime()))
        return null;
    const graceEnd = new Date(end.getTime() + Math.max(graceDays, 0) * 24 * 60 * 60 * 1000);
    if (now.getTime() <= graceEnd.getTime())
        return null;
    const adjustmentEnd = campaign.adjustment_window_end
        ? new Date(campaign.adjustment_window_end)
        : null;
    if (status === "closed" &&
        adjustmentEnd &&
        !Number.isNaN(adjustmentEnd.getTime()) &&
        now.getTime() <= adjustmentEnd.getTime()) {
        return null;
    }
    return "The receipt window has closed (campaign end date plus grace period).";
}
//# sourceMappingURL=receipt-upload-window.js.map