"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCampaignVisibility = buildCampaignVisibility;
const campaign_timing_1 = require("./campaign-timing");
const TRACK_DISPLAY = {
    not_selected: "Not selected",
    ready: "Ready",
    waiting_on_business_acceptance: "Waiting on business acceptance",
    event_details_needed: "Event details needed",
    payment_setup_needed: "Payment setup needed",
    pending_setup: "Setup needed",
    needs_forkup_review: "Needs ForkUp Review",
    limited_promotion_window: "Limited Promotion Window",
};
function isAccepted(status) {
    return ["accepted", "ready", "live", "completed"].includes(status);
}
function isAwaitingBusiness(status) {
    return ["draft", "invited", "opened", "pending", "changes_requested", "needs_info"].includes(status);
}
function buildCampaignVisibility(input) {
    const methods = input.methods;
    const accepted = input.partners.filter((p) => isAccepted(String(p.acceptanceStatus)));
    const awaiting = input.partners.filter((p) => isAwaitingBusiness(String(p.acceptanceStatus)));
    const missingSetup = accepted.filter((p) => String(p.setupStatus) === "needs_info" ||
        String(p.settlementReadyStatus) === "needs_info" ||
        String(p.inviteStatus) === "needs_info");
    const timingGate = input.businessTimingStatus === "limited_promotion_window"
        ? "limited_promotion_window"
        : input.businessTimingStatus === "needs_forkup_review" ||
            input.forkupReviewStatus === "pending"
            ? "needs_forkup_review"
            : null;
    const basicsReady = Boolean(input.storyPresent && input.endDate);
    let online = "not_selected";
    if (methods.includes("virtual_donations")) {
        online = basicsReady ? "ready" : "pending_setup";
    }
    let ambassador = "not_selected";
    if (methods.includes("ambassador_fundraising") || (0, campaign_timing_1.hasGuestBartending)(methods)) {
        ambassador = basicsReady ? "ready" : "pending_setup";
    }
    let giveback = "not_selected";
    if ((0, campaign_timing_1.hasGivebackMethods)(methods)) {
        if (timingGate)
            giveback = timingGate;
        else if (accepted.length > 0)
            giveback = "ready";
        else
            giveback = "waiting_on_business_acceptance";
    }
    let guest = "not_selected";
    if ((0, campaign_timing_1.hasGuestBartending)(methods)) {
        if (timingGate)
            guest = timingGate;
        else if (!input.eventDate)
            guest = "event_details_needed";
        else if (accepted.length > 0)
            guest = "ready";
        else
            guest = "waiting_on_business_acceptance";
    }
    let settlement = "not_selected";
    if ((0, campaign_timing_1.hasGivebackMethods)(methods) || (0, campaign_timing_1.hasGuestBartending)(methods)) {
        if (accepted.length === 0)
            settlement = "waiting_on_business_acceptance";
        else if (missingSetup.length > 0)
            settlement = "payment_setup_needed";
        else
            settlement = "ready";
    }
    else if ((0, campaign_timing_1.hasDefaultFundraisingLayer)(methods)) {
        settlement = "ready";
    }
    const trackDefs = [
        { id: "online", label: "Online Donations", status: online },
        { id: "ambassador", label: "Ambassador Sharing", status: ambassador },
        { id: "giveback", label: "Business Giveback", status: giveback },
        { id: "guest", label: "Guest Bartending", status: guest },
        { id: "settlement", label: "Settlement", status: settlement },
    ];
    const tracks = trackDefs
        .filter((t) => t.status !== "not_selected")
        .map((t) => ({
        ...t,
        display: TRACK_DISPLAY[t.status],
    }));
    const ready = [];
    const pending = [];
    const needsForkupReview = [];
    const needsBusinessAction = [];
    for (const t of tracks) {
        if (t.status === "ready")
            ready.push(`${t.label}: Ready`);
        else if (t.status === "needs_forkup_review") {
            needsForkupReview.push(`${t.label}: Needs ForkUp Review`);
        }
        else if (t.status === "limited_promotion_window") {
            pending.push(`${t.label}: Limited Promotion Window`);
        }
        else {
            pending.push(`${t.label}: ${t.display}`);
        }
    }
    if (input.businessTimingStatus === "needs_forkup_review" ||
        input.forkupReviewStatus === "pending") {
        if (!needsForkupReview.length) {
            needsForkupReview.push("Business methods need ForkUp review before invites can proceed.");
        }
    }
    for (const p of awaiting) {
        const by = p.respondByDate ? ` (respond by ${p.respondByDate})` : "";
        needsBusinessAction.push(`${p.businessName}: awaiting response${by}`);
    }
    for (const p of missingSetup) {
        needsBusinessAction.push(`${p.businessName}: finish setup / payment info`);
    }
    if (input.campaignStatus === "draft" && ready.length === 0 && pending.length === 0) {
        pending.push("Campaign setup still in progress");
    }
    return {
        tracks,
        ready,
        pending,
        needsForkupReview,
        needsBusinessAction,
        nextSuccessEngineAction: input.nextSuccessEngineAction ?? null,
    };
}
//# sourceMappingURL=campaign-visibility.js.map