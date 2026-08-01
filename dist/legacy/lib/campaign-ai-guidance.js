"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasGuestBartending = exports.hasGivebackMethods = exports.hasDefaultFundraisingLayer = exports.hasBusinessMethods = void 0;
exports.scoreInviteReadiness = scoreInviteReadiness;
exports.recommendMethodMix = recommendMethodMix;
exports.buildTimingGuidance = buildTimingGuidance;
exports.polishGuidanceWithAi = polishGuidanceWithAi;
exports.describeMethods = describeMethods;
const ai_chat_1 = require("./ai-chat");
const campaign_timing_1 = require("./campaign-timing");
Object.defineProperty(exports, "hasBusinessMethods", { enumerable: true, get: function () { return campaign_timing_1.hasBusinessMethods; } });
Object.defineProperty(exports, "hasDefaultFundraisingLayer", { enumerable: true, get: function () { return campaign_timing_1.hasDefaultFundraisingLayer; } });
Object.defineProperty(exports, "hasGivebackMethods", { enumerable: true, get: function () { return campaign_timing_1.hasGivebackMethods; } });
Object.defineProperty(exports, "hasGuestBartending", { enumerable: true, get: function () { return campaign_timing_1.hasGuestBartending; } });
function clampScore(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
}
function scoreInviteReadiness(input) {
    const factors = [];
    let score = 0;
    if (input.hasNonprofitProfile) {
        factors.push({ label: "Nonprofit profile", points: 15, note: "Profile available" });
        score += 15;
    }
    else {
        factors.push({ label: "Nonprofit profile", points: 0, note: "Complete nonprofit profile" });
    }
    if (input.hasStory) {
        factors.push({ label: "Campaign story", points: 20, note: "Story present" });
        score += 20;
    }
    else {
        factors.push({ label: "Campaign story", points: 0, note: "Add a clearer campaign purpose" });
    }
    if (input.hasCover) {
        factors.push({ label: "Featured image", points: 10, note: "Cover ready" });
        score += 10;
    }
    else {
        factors.push({ label: "Featured image", points: 0, note: "Choose a featured image" });
    }
    const timing = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
        methods: input.methods,
        startDate: input.startDate,
        eventDate: input.eventDate,
    });
    if (!(0, campaign_timing_1.hasBusinessMethods)(input.methods)) {
        factors.push({
            label: "Business timing",
            points: 25,
            note: "No business method selected",
        });
        score += 25;
    }
    else if (timing.status === "ok") {
        factors.push({
            label: "Business timing",
            points: 25,
            note: `${timing.daysUntilAnchor ?? "?"} days lead time`,
        });
        score += 25;
    }
    else {
        factors.push({
            label: "Business timing",
            points: 5,
            note: "Needs ForkUp review or date change",
        });
        score += 5;
    }
    if (input.hasBusinessContacts) {
        factors.push({ label: "Business contacts", points: 15, note: "Contact info available" });
        score += 15;
    }
    else if ((0, campaign_timing_1.hasBusinessMethods)(input.methods)) {
        factors.push({ label: "Business contacts", points: 0, note: "Add business contact emails" });
    }
    else {
        factors.push({ label: "Business contacts", points: 15, note: "N/A" });
        score += 15;
    }
    const invited = input.invitedBusinessCount ?? 0;
    if (!(0, campaign_timing_1.hasBusinessMethods)(input.methods)) {
        factors.push({ label: "Invite list", points: 15, note: "N/A" });
        score += 15;
    }
    else if (invited >= 3) {
        factors.push({ label: "Invite list", points: 15, note: `${invited} businesses selected` });
        score += 15;
    }
    else if (invited > 0) {
        factors.push({
            label: "Invite list",
            points: 8,
            note: "Consider inviting 6–10 businesses",
        });
        score += 8;
    }
    else {
        factors.push({ label: "Invite list", points: 0, note: "Select businesses to invite" });
    }
    score = clampScore(score);
    const summary = score >= 75
        ? `Business Invite Readiness: ${score} / 100 — ready to invite businesses.`
        : score >= 50
            ? `Business Invite Readiness: ${score} / 100 — almost ready; tighten story, dates, or contacts.`
            : `Business Invite Readiness: ${score} / 100 — needs work before business invitations go out.`;
    return {
        score,
        summary,
        factors,
        aiExplanation: null,
        provider: (0, ai_chat_1.aiProviderName)(),
    };
}
function recommendMethodMix(input) {
    const selected = input.methods ?? [];
    const timing = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
        methods: selected.length
            ? selected
            : ["dine_and_donate"],
        startDate: input.startDate,
        eventDate: input.eventDate,
    });
    const recommended = [
        "virtual_donations",
        "ambassador_fundraising",
    ];
    let summary = "Start with Online Donations and Ambassador Sharing so momentum can build immediately.";
    const days = timing.daysUntilAnchor;
    if (days != null && days >= 30) {
        recommended.push("dine_and_donate");
        summary +=
            " Your timeline supports adding Dine & Donate / Local Giveback. Invite businesses this week.";
    }
    else if ((0, campaign_timing_1.hasGivebackMethods)(selected) || (0, campaign_timing_1.hasGuestBartending)(selected)) {
        summary +=
            " Business methods are selected but the timeline is short — keep online/ambassador moving and submit business methods for ForkUp review or move the date.";
    }
    else if (days != null && days < 30) {
        summary +=
            " With fewer than 30 days, avoid adding business giveback unless ForkUp approves.";
    }
    if ((0, campaign_timing_1.hasGuestBartending)(selected)) {
        if (!recommended.includes("guest_bartending_event")) {
            recommended.push("guest_bartending_event");
        }
        summary +=
            " Guest Bartending works best as a single-day event with at least 30 days of promotion; Ambassador Sharing stays included.";
    }
    return {
        recommended,
        summary,
        aiExplanation: null,
        provider: (0, ai_chat_1.aiProviderName)(),
    };
}
function buildTimingGuidance(input) {
    const timing = (0, campaign_timing_1.evaluateBusinessMethodTiming)(input);
    const summary = timing.status === "ok"
        ? (0, campaign_timing_1.hasBusinessMethods)(input.methods)
            ? `Business-method timeline looks healthy (${timing.daysUntilAnchor ?? "?"} days to ${timing.anchorKind}).`
            : "No business methods selected — online/ambassador timing rules apply (end date; no 30-day hard block)."
        : timing.message ||
            "This business-method timeline needs ForkUp review.";
    return {
        timing,
        summary,
        aiExplanation: null,
        provider: (0, ai_chat_1.aiProviderName)(),
    };
}
async function polishGuidanceWithAi(input) {
    if ((0, ai_chat_1.aiProviderName)() === "none")
        return null;
    try {
        const text = await (0, ai_chat_1.aiChat)({
            system: `${input.systemHint}\n` +
                "You are ForkUp's campaign coach. Explain clearly, never claim a business is already enrolled, " +
                "and never contradict hard platform rules (30-day business lead time, 21-day acceptance for full SE, " +
                "not public until accepted). Keep under 120 words.",
            user: input.facts,
            temperature: 0.4,
            maxTokens: 400,
        });
        return text.trim() || null;
    }
    catch {
        return null;
    }
}
function describeMethods(methods) {
    return methods.join(", ") || "(none)";
}
//# sourceMappingURL=campaign-ai-guidance.js.map