"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AMBASSADOR_RECOMMENDED_DAYS = exports.FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = exports.BUSINESS_METHOD_MIN_LEAD_DAYS = void 0;
exports.daysUntil = daysUntil;
exports.hasBusinessMethods = hasBusinessMethods;
exports.hasGivebackMethods = hasGivebackMethods;
exports.hasGuestBartending = hasGuestBartending;
exports.hasDefaultFundraisingLayer = hasDefaultFundraisingLayer;
exports.validateMethodDateRequirements = validateMethodDateRequirements;
exports.evaluateBusinessMethodTiming = evaluateBusinessMethodTiming;
exports.evaluateAcceptancePromotionWindow = evaluateAcceptancePromotionWindow;
exports.ambassadorTimingCoachMessage = ambassadorTimingCoachMessage;
const date_only_1 = require("./date-only");
const methods_1 = require("./methods");
exports.BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
exports.FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = 21;
exports.AMBASSADOR_RECOMMENDED_DAYS = 14;
function todayDateOnly() {
    return (0, date_only_1.toDateOnlyString)(new Date()) ?? "";
}
function daysUntil(dateStr) {
    const target = (0, date_only_1.toDateOnlyString)(dateStr);
    if (!target)
        return null;
    const today = todayDateOnly();
    if (!today)
        return null;
    const [ty, tm, td] = today.split("-").map(Number);
    const [ay, am, ad] = target.split("-").map(Number);
    const t0 = new Date(ty, tm - 1, td).getTime();
    const a0 = new Date(ay, am - 1, ad).getTime();
    return Math.round((a0 - t0) / (24 * 60 * 60 * 1000));
}
function hasBusinessMethods(methods) {
    return methods.some((m) => methods_1.METHOD_REQUIRES_BUSINESS[m]);
}
function hasGivebackMethods(methods) {
    return methods.some((m) => m === "dine_and_donate" ||
        m === "shop_and_donate" ||
        m === "service_giveback");
}
function hasGuestBartending(methods) {
    return methods.includes("guest_bartending_event");
}
function hasDefaultFundraisingLayer(methods) {
    return methods.some((m) => !methods_1.METHOD_REQUIRES_BUSINESS[m]);
}
function validateMethodDateRequirements(input) {
    const { methods } = input;
    const endDate = (0, date_only_1.toDateOnlyString)(input.endDate);
    const startDate = (0, date_only_1.toDateOnlyString)(input.startDate);
    const eventDate = (0, date_only_1.toDateOnlyString)(input.eventDate);
    if (!endDate && !hasGuestBartending(methods)) {
        if (!hasBusinessMethods(methods) || hasDefaultFundraisingLayer(methods) || hasGivebackMethods(methods)) {
            return "Campaign end date is required";
        }
    }
    if (hasGivebackMethods(methods)) {
        if (!startDate)
            return "Campaign start date is required for Dine & Donate / Local Giveback";
        if (!endDate)
            return "Campaign end date is required for Dine & Donate / Local Giveback";
    }
    if (hasGuestBartending(methods)) {
        if (!eventDate)
            return "Event date is required for Guest Bartending";
    }
    if (!hasBusinessMethods(methods) && !endDate) {
        return "Campaign end date is required";
    }
    return null;
}
function evaluateBusinessMethodTiming(input) {
    const methods = input.methods;
    const reviewApproved = input.forkupReviewStatus === "approved";
    if (!hasBusinessMethods(methods)) {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: null,
            anchorDate: null,
            anchorKind: null,
        };
    }
    const GIVEBACK_SHORT_MSG = "This campaign starts in less than 30 days. Business giveback campaigns need time for businesses to accept, prepare their team, and promote the campaign. ForkUp review is required before inviting businesses for this timeline.";
    const GUEST_SHORT_MSG = "Guest Bartending events need enough time to confirm the venue, prepare the guest bartenders, promote the event, and alert the business team. ForkUp review is required for events less than 30 days away.";
    const OTHER_BUSINESS_SHORT_MSG = "This business-based method starts in less than 30 days. ForkUp review is required before proceeding normally.";
    const shortMessages = [];
    let worstDays = null;
    let anchorDate = null;
    let anchorKind = null;
    const considerAnchor = (dateStr, kind, shortMessage) => {
        const normalized = (0, date_only_1.toDateOnlyString)(dateStr);
        const days = daysUntil(normalized);
        if (days == null)
            return;
        if (worstDays == null || days < worstDays) {
            worstDays = days;
            anchorDate = normalized;
            anchorKind = kind;
        }
        if (days < exports.BUSINESS_METHOD_MIN_LEAD_DAYS && !reviewApproved) {
            shortMessages.push(shortMessage);
        }
    };
    if (hasGivebackMethods(methods)) {
        considerAnchor(input.startDate, "start", GIVEBACK_SHORT_MSG);
    }
    if (hasGuestBartending(methods)) {
        considerAnchor(input.eventDate, "event", GUEST_SHORT_MSG);
    }
    if (!hasGivebackMethods(methods) && !hasGuestBartending(methods)) {
        considerAnchor(input.startDate, "start", OTHER_BUSINESS_SHORT_MSG);
    }
    if (worstDays == null) {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: null,
            anchorDate,
            anchorKind,
        };
    }
    if (shortMessages.length === 0) {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: worstDays,
            anchorDate,
            anchorKind,
        };
    }
    return {
        status: "needs_forkup_review",
        message: shortMessages.join(" "),
        ctas: [
            "change_date",
            "continue_without_business_method",
            "submit_for_forkup_review",
        ],
        daysUntilAnchor: worstDays,
        anchorDate,
        anchorKind,
    };
}
function evaluateAcceptancePromotionWindow(input) {
    const days = daysUntil(input.startOrEventDate);
    if (days == null)
        return "ok";
    if (days < exports.FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS) {
        return "limited_promotion_window";
    }
    return "ok";
}
function ambassadorTimingCoachMessage(endDate) {
    const days = daysUntil(endDate);
    if (days == null)
        return null;
    if (days < exports.AMBASSADOR_RECOMMENDED_DAYS) {
        return "This campaign can launch, but a longer window usually gives ambassadors more time to share and raise support.";
    }
    return null;
}
//# sourceMappingURL=campaign-timing.js.map