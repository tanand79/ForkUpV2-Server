"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeJoinGivebackMode = normalizeJoinGivebackMode;
exports.normalizeJoinCauseMode = normalizeJoinCauseMode;
exports.normalizePreferredCampaignSlug = normalizePreferredCampaignSlug;
const GIVEBACK_MODES = [
    "restaurant_dine_percent",
    "percent_of_purchase",
    "dollar_per_visit",
    "special_offer",
];
const CAUSE_MODES = ["pick_now", "forkup_match"];
function normalizeJoinGivebackMode(raw) {
    if (typeof raw !== "string")
        return null;
    const v = raw.trim().toLowerCase();
    return GIVEBACK_MODES.includes(v) ? v : null;
}
function normalizeJoinCauseMode(raw) {
    if (typeof raw !== "string")
        return null;
    const v = raw.trim().toLowerCase();
    return CAUSE_MODES.includes(v) ? v : null;
}
function normalizePreferredCampaignSlug(raw) {
    if (typeof raw !== "string")
        return null;
    const v = raw.trim();
    if (!v)
        return null;
    return v.length <= 255 ? v : v.slice(0, 255);
}
//# sourceMappingURL=join-giveback-prefs.js.map