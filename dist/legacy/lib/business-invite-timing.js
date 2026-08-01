"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_INVITE_RESPONSE_DAYS = void 0;
exports.computeRespondByDate = computeRespondByDate;
exports.isRespondByPassed = isRespondByPassed;
exports.deriveSetupReadiness = deriveSetupReadiness;
const date_only_1 = require("./date-only");
const campaign_timing_1 = require("./campaign-timing");
exports.DEFAULT_INVITE_RESPONSE_DAYS = 7;
function computeRespondByDate(input) {
    const sent = (0, date_only_1.toDateOnlyString)(input.sentDate) ?? (0, date_only_1.toDateOnlyString)(new Date()) ?? "";
    if (!sent) {
        return (0, date_only_1.toDateOnlyString)(new Date()) ?? "";
    }
    const defaultRespondBy = (0, date_only_1.addCalendarDays)(sent, exports.DEFAULT_INVITE_RESPONSE_DAYS);
    const anchor = (0, date_only_1.toDateOnlyString)(input.startOrEventDate);
    if (!anchor)
        return defaultRespondBy;
    const seFloor = (0, date_only_1.subtractCalendarDays)(anchor, campaign_timing_1.FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS);
    let respondBy = seFloor && seFloor < defaultRespondBy ? seFloor : defaultRespondBy;
    if (respondBy < sent) {
        respondBy = defaultRespondBy;
    }
    return respondBy;
}
function isRespondByPassed(respondByDate) {
    const respondBy = (0, date_only_1.toDateOnlyString)(respondByDate);
    const today = (0, date_only_1.toDateOnlyString)(new Date());
    if (!respondBy || !today)
        return false;
    return respondBy < today;
}
function deriveSetupReadiness(input) {
    const hasRep = Boolean(input.authorizedRepresentative?.trim());
    const hasBilling = Boolean(input.billingContactEmail?.includes("@"));
    const hasSettlement = Boolean(input.settlementContactEmail?.includes("@"));
    const hasAch = Boolean(input.achAuthorized);
    const complete = hasRep && hasBilling && hasSettlement && hasAch;
    if (complete) {
        return {
            setupStatus: "ready",
            settlementReadyStatus: "ready",
            marketingReadyStatus: "ready",
            inviteStatusAfterAccept: "ready",
        };
    }
    return {
        setupStatus: "needs_info",
        settlementReadyStatus: hasAch && hasSettlement ? "ready" : "needs_info",
        marketingReadyStatus: "pending",
        inviteStatusAfterAccept: "needs_info",
    };
}
//# sourceMappingURL=business-invite-timing.js.map