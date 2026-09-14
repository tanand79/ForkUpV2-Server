"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSuccessEngineCalendar = buildSuccessEngineCalendar;
const date_only_1 = require("./date-only");
const methods_1 = require("./methods");
function daysBefore(anchor, days) {
    return (0, date_only_1.subtractCalendarDays)(anchor, days);
}
function clampNotAfter(date, end) {
    return date > end ? end : date;
}
function buildSuccessEngineCalendar(input) {
    const start = (0, date_only_1.toDateOnlyString)(input.startDate) ||
        (0, date_only_1.toDateOnlyString)(input.eventDate) ||
        (0, date_only_1.toDateOnlyString)(input.endDate);
    const end = (0, date_only_1.toDateOnlyString)(input.endDate) ||
        (0, date_only_1.toDateOnlyString)(input.eventDate) ||
        start;
    if (!start || !end)
        return [];
    const name = input.campaignName || "your campaign";
    const org = input.nonprofitName || "the nonprofit";
    const hasBusiness = input.methods.some((m) => methods_1.METHOD_REQUIRES_BUSINESS[m]);
    const hasAmbassador = input.methods.includes("ambassador_fundraising") ||
        input.methods.includes("guest_bartending_event");
    const hasOnline = input.methods.includes("virtual_donations");
    const canBusinessPromo = Boolean(input.hasAcceptedBusiness);
    const actions = [];
    const push = (action_type, daysOut, title, content, stakeholder_role, channel = "email") => {
        const scheduled = clampNotAfter(daysBefore(start, daysOut), end);
        actions.push({
            action_type,
            channel,
            scheduled_date: scheduled,
            title,
            content,
            stakeholder_role,
            generated_by: "system",
        });
    };
    push("nonprofit_announcement", 50, "Draft nonprofit announcement", `Prepare an announcement for ${org} supporters about "${name}".`, "nonprofit");
    if (hasBusiness) {
        push("business_invite_reminder", 40, "Send / follow up business invitations", `Invite or remind local businesses for "${name}". Nothing is public until they accept.`, "nonprofit");
    }
    if (hasAmbassador) {
        push("ambassador_recruitment", 35, "Invite ambassadors", `Recruit ambassadors to share "${name}" with their networks.`, "ambassador");
    }
    if (hasBusiness && canBusinessPromo) {
        push("staff_talking_points", 25, "Business staff talking points", `Share talking points and QR language with participating businesses for "${name}".`, "business");
        push("business_promotion", 22, "Business launch kit", `Promotional materials are ready for accepted business partners of "${name}".`, "business");
    }
    push("launch_email", 14, "Campaign announcement email", `Announce "${name}" to supporters. Share the campaign page and how to participate.`, "nonprofit");
    push("social_post", 14, "Social post #1", `Share the first social post for "${name}".`, "nonprofit", "social");
    push("one_week_reminder", 7, "One week reminder", `One week until "${name}" — remind supporters and partners.`, "nonprofit");
    push("countdown_reminder", 7, "Countdown reminder", `Countdown content for "${name}".`, "supporter");
    if (hasBusiness && canBusinessPromo) {
        push("day_of_reminder", 1, "Business day-of reminder", `Remind business teams that "${name}" is live / starting.`, "business");
    }
    if (hasOnline || hasAmbassador) {
        push("mid_campaign_reminder", 0, "Mid-campaign nudge", `Keep momentum for "${name}" — share progress and donation links.`, "nonprofit");
    }
    push("final_push_reminder", 0, "Final push", `Final push for "${name}" before the campaign ends.`, "nonprofit");
    if (hasOnline || hasBusiness) {
        push("receipt_reminder", 0, "Receipt upload reminder", `Remind supporters how to upload receipts for "${name}" if applicable.`, "supporter");
    }
    const thankYouDate = (0, date_only_1.addCalendarDays)(end, 1);
    actions.push({
        action_type: "thank_you",
        channel: "email",
        scheduled_date: thankYouDate,
        title: "Thank-you message",
        content: `Thank supporters and partners for "${name}".`,
        stakeholder_role: "nonprofit",
        generated_by: "system",
    });
    actions.push({
        action_type: "results_email",
        channel: "email",
        scheduled_date: (0, date_only_1.addCalendarDays)(end, 3),
        title: "Results recap",
        content: `Share results and impact for "${name}".`,
        stakeholder_role: "nonprofit",
        generated_by: "system",
    });
    actions.push({
        action_type: "settlement_recap",
        channel: "email",
        scheduled_date: (0, date_only_1.addCalendarDays)(end, 5),
        title: "Settlement recap",
        content: `Prepare settlement explanations for "${name}".`,
        stakeholder_role: "admin",
        generated_by: "system",
    });
    actions.push({
        action_type: "rebooking_prompt",
        channel: "email",
        scheduled_date: (0, date_only_1.addCalendarDays)(end, 14),
        title: "Rebooking prompt",
        content: `Invite ${org} to plan their next ForkUp campaign.`,
        stakeholder_role: "nonprofit",
        generated_by: "system",
    });
    const seen = new Set();
    return actions.filter((a) => {
        const key = `${a.action_type}|${a.scheduled_date}|${a.stakeholder_role}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
//# sourceMappingURL=success-engine-calendar.js.map