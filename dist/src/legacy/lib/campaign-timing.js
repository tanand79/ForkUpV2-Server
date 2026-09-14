"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AMBASSADOR_RECOMMENDED_DAYS = exports.FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = exports.TIGHT_TIMELINE_MIN_DAYS = exports.LIMITED_PROMOTION_LEAD_DAYS = exports.BUSINESS_METHOD_MIN_LEAD_DAYS = void 0;
exports.daysUntil = daysUntil;
exports.hasBusinessMethods = hasBusinessMethods;
exports.hasGivebackMethods = hasGivebackMethods;
exports.hasGuestBartending = hasGuestBartending;
exports.hasDefaultFundraisingLayer = hasDefaultFundraisingLayer;
exports.timingBandFromDays = timingBandFromDays;
exports.isBusinessConfirmationComplete = isBusinessConfirmationComplete;
exports.validateBusinessConfirmation = validateBusinessConfirmation;
exports.hasAnyBusinessConfirmationField = hasAnyBusinessConfirmationField;
exports.allowsBusinessInviteEmails = allowsBusinessInviteEmails;
exports.validateMethodDateRequirements = validateMethodDateRequirements;
exports.evaluateBusinessMethodTiming = evaluateBusinessMethodTiming;
exports.evaluateAcceptancePromotionWindow = evaluateAcceptancePromotionWindow;
exports.ambassadorTimingCoachMessage = ambassadorTimingCoachMessage;
const date_only_1 = require("./date-only");
const methods_1 = require("./methods");
exports.BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
exports.LIMITED_PROMOTION_LEAD_DAYS = 21;
exports.TIGHT_TIMELINE_MIN_DAYS = 8;
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
function timingBandFromDays(days) {
    if (days >= exports.BUSINESS_METHOD_MIN_LEAD_DAYS)
        return "ok";
    if (days >= exports.LIMITED_PROMOTION_LEAD_DAYS)
        return "limited_promotion_window";
    if (days >= exports.TIGHT_TIMELINE_MIN_DAYS)
        return "tight_timeline";
    return "too_soon";
}
function isBusinessConfirmationComplete(input) {
    if (!input)
        return false;
    const name = String(input.confirmedBusinessName ?? "").trim();
    const contact = String(input.confirmedContactName ?? "").trim();
    const email = String(input.confirmedContactEmail ?? "").trim();
    const method = String(input.confirmedMethod ?? "").trim().toLowerCase();
    const status = String(input.confirmedStatus ?? "").trim();
    if (!name || !contact || !email || !method || !status)
        return false;
    if (!["email", "phone", "in_person"].includes(method))
        return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return false;
    return true;
}
function validateBusinessConfirmation(input) {
    if (isBusinessConfirmationComplete(input))
        return null;
    return "Business confirmation requires business name, contact name, contact email, confirmation method (email / phone / in person), and confirmation status";
}
function hasAnyBusinessConfirmationField(input) {
    if (!input)
        return false;
    return Boolean(String(input.confirmedBusinessName ?? "").trim() ||
        String(input.confirmedContactName ?? "").trim() ||
        String(input.confirmedContactEmail ?? "").trim() ||
        String(input.confirmedMethod ?? "").trim() ||
        String(input.confirmedStatus ?? "").trim() ||
        String(input.confirmedNotes ?? "").trim());
}
function allowsBusinessInviteEmails(status, opts) {
    if (opts?.forkupReviewStatus === "approved")
        return true;
    const s = status ?? "ok";
    if (s === "ok" || s === "limited_promotion_window")
        return true;
    if (s === "tight_timeline" && opts?.businessConfirmed)
        return true;
    return false;
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
    const today = todayDateOnly();
    if (startDate && today && startDate < today) {
        return "Campaign start date cannot be in the past";
    }
    if (endDate && today && endDate < today) {
        return "Campaign end date cannot be in the past";
    }
    if (eventDate && today && eventDate < today) {
        return "Event date cannot be in the past";
    }
    return null;
}
function bandMessage(status, days, kind) {
    const when = kind === "event" ? `event is ${days} day${days === 1 ? "" : "s"} away` : `campaign starts in ${days} day${days === 1 ? "" : "s"}`;
    if (status === "limited_promotion_window") {
        return `Limited promotion window: your ${when}. You can continue, but there is less time for businesses to accept and for full promotion.`;
    }
    if (status === "tight_timeline") {
        return `Tight timeline: your ${when}. Businesses usually need more time to prepare and promote. Confirm an existing business agreement, submit for ForkUp review, change the date, or continue with Online Donation / Ambassador Sharing only.`;
    }
    if (status === "too_soon") {
        return `Too soon: your ${when}. New business-based campaigns cannot start within 7 days. Change the date or switch to Online Donation / Ambassador Sharing.`;
    }
    return "";
}
const TIGHT_CTAS = [
    "change_date",
    "continue_without_business_method",
    "confirm_business",
    "submit_for_forkup_review",
];
const TOO_SOON_CTAS = [
    "change_date",
    "continue_without_business_method",
];
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
    let worstDays = null;
    let anchorDate = null;
    let anchorKind = null;
    const considerAnchor = (dateStr, kind) => {
        const normalized = (0, date_only_1.toDateOnlyString)(dateStr);
        const days = daysUntil(normalized);
        if (days == null)
            return;
        if (worstDays == null || days < worstDays) {
            worstDays = days;
            anchorDate = normalized;
            anchorKind = kind;
        }
    };
    if (hasGivebackMethods(methods)) {
        considerAnchor(input.startDate, "start");
    }
    if (hasGuestBartending(methods)) {
        considerAnchor(input.eventDate, "event");
    }
    if (!hasGivebackMethods(methods) && !hasGuestBartending(methods)) {
        considerAnchor(input.startDate, "start");
    }
    if (worstDays == null || !anchorKind) {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: null,
            anchorDate,
            anchorKind,
        };
    }
    if (reviewApproved) {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: worstDays,
            anchorDate,
            anchorKind,
        };
    }
    const band = timingBandFromDays(worstDays);
    if (band === "ok") {
        return {
            status: "ok",
            message: null,
            ctas: [],
            daysUntilAnchor: worstDays,
            anchorDate,
            anchorKind,
        };
    }
    const message = bandMessage(band, worstDays, anchorKind);
    if (band === "limited_promotion_window") {
        return {
            status: "limited_promotion_window",
            message,
            ctas: [],
            daysUntilAnchor: worstDays,
            anchorDate,
            anchorKind,
        };
    }
    if (band === "tight_timeline") {
        return {
            status: "tight_timeline",
            message,
            ctas: [...TIGHT_CTAS],
            daysUntilAnchor: worstDays,
            anchorDate,
            anchorKind,
        };
    }
    return {
        status: "too_soon",
        message,
        ctas: [...TOO_SOON_CTAS],
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