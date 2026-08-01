"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.participationLabelFromMethods = participationLabelFromMethods;
exports.formatCampaignDateLabel = formatCampaignDateLabel;
exports.renderInitialInvitation = renderInitialInvitation;
exports.renderInviteReminder = renderInviteReminder;
exports.renderAcceptedConfirmation = renderAcceptedConfirmation;
exports.renderDeclinedConfirmation = renderDeclinedConfirmation;
exports.renderMissingInfo = renderMissingInfo;
exports.renderLaunchKit = renderLaunchKit;
exports.renderStartingSoon = renderStartingSoon;
exports.renderSettlementReady = renderSettlementReady;
exports.renderBusinessEmail = renderBusinessEmail;
const methods_1 = require("./methods");
const TRUST_NOT_ENROLLED = "You are not automatically enrolled, and nothing will be shown publicly for your business unless you choose to accept.";
function greeting(ctx) {
    const name = (ctx.businessContactName || ctx.businessName || "there").trim();
    return `Hi ${name},`;
}
function purposeBlock(ctx) {
    const purpose = (ctx.campaignPurpose || "").trim();
    return purpose || "Supporting their community through a local giveback campaign.";
}
function participationLabelFromMethods(methods) {
    if (!methods.length)
        return "Local giveback partnership";
    const labels = methods.map((m) => methods_1.METHOD_LABELS[m] || m);
    return labels.join(" / ");
}
function formatCampaignDateLabel(input) {
    const event = input.eventDate?.trim();
    if (event)
        return event;
    const start = input.startDate?.trim();
    const end = input.endDate?.trim();
    if (start && end)
        return `${start} – ${end}`;
    if (start)
        return start;
    if (end)
        return `Through ${end}`;
    return "Dates to be confirmed";
}
function renderInitialInvitation(ctx) {
    const subject = `${ctx.nonprofitName} invited ${ctx.businessName} to support their ForkUp campaign`;
    const body = `${greeting(ctx)}\n\n` +
        `${ctx.nonprofitName} has invited ${ctx.businessName} to participate in an upcoming ForkUp fundraising campaign.\n\n` +
        `ForkUp helps nonprofits and local businesses run giveback campaigns where supporters can raise money through online donations, ambassador sharing, and participating local businesses.\n\n` +
        `${TRUST_NOT_ENROLLED}\n\n` +
        `Campaign:\n${ctx.campaignTitle}\n\n` +
        `What the nonprofit is raising money for:\n${purposeBlock(ctx)}\n\n` +
        `Requested participation:\n${ctx.participationLabel}\n\n` +
        `Proposed campaign dates/event date:\n${ctx.dateRangeLabel}\n\n` +
        (ctx.respondByDate ? `Please respond by:\n${ctx.respondByDate}\n\n` : "") +
        `If you accept, ForkUp will help prepare the campaign page, promotional materials, and instructions for your team.\n\n` +
        `Review Invitation:\n${ctx.reviewUrl}\n\n` +
        `Thank you,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_campaign_invitation",
        templateKey: "initial_invitation",
    };
}
function renderInviteReminder(ctx) {
    const subject = `Reminder: ${ctx.nonprofitName} campaign invitation`;
    const body = `${greeting(ctx)}\n\n` +
        `Just a quick reminder that ${ctx.nonprofitName} invited you to participate in their upcoming ForkUp campaign.\n\n` +
        (ctx.respondByDate
            ? `They are hoping to confirm participating businesses by ${ctx.respondByDate} so there is enough time to prepare marketing and launch materials.\n\n`
            : `They are hoping to confirm participating businesses soon so there is enough time to prepare marketing and launch materials.\n\n`) +
        `You can review the invitation here:\n${ctx.reviewUrl}\n\n` +
        `Nothing is live for your business unless you accept.\n\n` +
        `Thank you,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_invite_reminder",
        templateKey: "invite_reminder",
    };
}
function renderAcceptedConfirmation(ctx) {
    const dash = ctx.dashboardUrl || ctx.reviewUrl;
    const subject = `You're confirmed for ${ctx.campaignTitle}`;
    const body = `${greeting(ctx)}\n\n` +
        `Thank you for accepting ${ctx.nonprofitName}'s ForkUp campaign invitation.\n\n` +
        `Your business is now listed as a participating partner for:\n${ctx.campaignTitle}\n\n` +
        `Campaign dates/event date:\n${ctx.dateRangeLabel}\n\n` +
        `Participation type:\n${ctx.participationLabel}\n\n` +
        `Next steps:\n` +
        `- Review your business details\n` +
        `- Confirm your giveback terms\n` +
        `- Review your campaign marketing materials\n` +
        `- Share the campaign with your team and guests\n\n` +
        `Open Business Campaign Dashboard:\n${dash}\n\n` +
        `Thank you for supporting your local community,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_accepted_confirmation",
        templateKey: "accepted_confirmation",
    };
}
function renderDeclinedConfirmation(ctx) {
    const subject = "Thanks for your response";
    const body = `${greeting(ctx)}\n\n` +
        `Thank you for reviewing the invitation from ${ctx.nonprofitName}.\n\n` +
        `We have marked your response as declined for this campaign.\n\n` +
        `You will not be listed as a participating business, and no action is needed from you.\n\n` +
        `Thank you,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_declined_confirmation",
        templateKey: "declined_confirmation",
    };
}
function renderMissingInfo(ctx) {
    const finishUrl = ctx.dashboardUrl || ctx.reviewUrl;
    const subject = "Action needed: finish setting up your ForkUp campaign participation";
    const body = `${greeting(ctx)}\n\n` +
        `Thank you for accepting ${ctx.nonprofitName}'s campaign invitation.\n\n` +
        `A few items still need to be confirmed before your business is fully ready:\n\n` +
        `- Business contact\n` +
        `- Participation date or date range\n` +
        `- Giveback terms\n` +
        `- Payment / ACH setup\n` +
        `- Marketing contact\n\n` +
        `Please complete these items here:\n${finishUrl}\n\n` +
        `Once complete, ForkUp can prepare your campaign materials and mark your business as ready.\n\n` +
        `Thank you,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_missing_info",
        templateKey: "missing_info",
    };
}
function renderLaunchKit(ctx) {
    const materials = ctx.materialsUrl || ctx.dashboardUrl || ctx.reviewUrl;
    const subject = "Your ForkUp campaign materials are ready";
    const body = `${greeting(ctx)}\n\n` +
        `Your campaign materials for ${ctx.campaignTitle} are ready.\n\n` +
        `Campaign:\n${ctx.campaignTitle}\n\n` +
        `Nonprofit:\n${ctx.nonprofitName}\n\n` +
        `Campaign dates/event date:\n${ctx.dateRangeLabel}\n\n` +
        `Your participation:\n${ctx.participationLabel}\n\n` +
        `You can now access:\n` +
        `- Campaign link\n` +
        `- QR code\n` +
        `- Social media copy\n` +
        `- Staff talking points\n` +
        `- Guest instructions\n` +
        `- Receipt upload instructions, if applicable\n\n` +
        `Open Campaign Materials:\n${materials}\n\n` +
        `Thank you,\nThe ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_launch_kit",
        templateKey: "launch_kit",
    };
}
function renderStartingSoon(ctx) {
    const dash = ctx.dashboardUrl || ctx.reviewUrl;
    const when = ctx.startOrEventDate || ctx.dateRangeLabel;
    const subject = `${ctx.campaignTitle} starts soon`;
    const body = `${greeting(ctx)}\n\n` +
        `This is a reminder that ${ctx.campaignTitle} starts on ${when}.\n\n` +
        `Please make sure your team knows:\n\n` +
        `- The campaign dates or event date\n` +
        `- The giveback terms\n` +
        `- How guests should participate\n` +
        `- Where to find the QR code or campaign link\n` +
        `- How reporting/settlement will work\n\n` +
        `Open Business Dashboard:\n${dash}\n\n` +
        `Thank you for supporting ${ctx.nonprofitName}.\n\n` +
        `The ForkUp Team`;
    return {
        subject,
        body,
        emailType: "business_starting_soon",
        templateKey: "starting_soon",
    };
}
function renderSettlementReady(ctx) {
    const report = ctx.settlementReportUrl || ctx.dashboardUrl || ctx.reviewUrl;
    const subject = `Settlement report ready for ${ctx.campaignTitle}`;
    const body = `${greeting(ctx)}\n\n` +
        `The campaign for ${ctx.nonprofitName} has closed, and your settlement report is ready.\n\n` +
        `Campaign:\n${ctx.campaignTitle}\n\n` +
        `Campaign dates/event date:\n${ctx.dateRangeLabel}\n\n` +
        `Eligible sales / donation basis:\n${ctx.eligibleSales ?? "—"}\n\n` +
        `Donation amount owed:\n${ctx.donationAmount ?? "—"}\n\n` +
        `ForkUp platform fee:\n${ctx.forkupFee ?? "—"}\n\n` +
        `ACH deduction amount:\n${ctx.achAmount ?? ctx.forkupFee ?? "—"}\n\n` +
        `Please review the settlement report here:\n${report}\n\n` +
        `Thank you for supporting ${ctx.nonprofitName} and your local community.\n\n` +
        `The ForkUp Team`;
    return {
        subject,
        body,
        emailType: "settlement_business",
        templateKey: "settlement_ready",
    };
}
function renderBusinessEmail(key, ctx) {
    switch (key) {
        case "initial_invitation":
            return renderInitialInvitation(ctx);
        case "invite_reminder":
            return renderInviteReminder(ctx);
        case "accepted_confirmation":
            return renderAcceptedConfirmation(ctx);
        case "declined_confirmation":
            return renderDeclinedConfirmation(ctx);
        case "missing_info":
            return renderMissingInfo(ctx);
        case "launch_kit":
            return renderLaunchKit(ctx);
        case "starting_soon":
            return renderStartingSoon(ctx);
        case "settlement_ready":
            return renderSettlementReady(ctx);
        default: {
            const _exhaustive = key;
            return _exhaustive;
        }
    }
}
//# sourceMappingURL=business-email-templates.js.map