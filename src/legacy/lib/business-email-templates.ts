/**
 * Nick V2 Layer 5 — Business invitation email templates 1–8.
 *
 * Purpose: Render subject/body for business lifecycle emails with trust language.
 * Inputs: Campaign + business context fields. Outputs: { subject, body, emailType }.
 * Does not send mail — callers use mailer.sendEmail.
 */

import { METHOD_LABELS } from "./methods";
import type { MethodType } from "../types/campaign";

export type BusinessEmailTemplateKey =
  | "initial_invitation"
  | "invite_reminder"
  | "accepted_confirmation"
  | "declined_confirmation"
  | "missing_info"
  | "launch_kit"
  | "starting_soon"
  | "settlement_ready";

export type BusinessEmailContext = {
  businessName: string;
  businessContactName?: string | null;
  nonprofitName: string;
  campaignTitle: string;
  campaignPurpose?: string | null;
  participationLabel: string;
  dateRangeLabel: string;
  respondByDate?: string | null;
  startOrEventDate?: string | null;
  reviewUrl: string;
  dashboardUrl?: string | null;
  materialsUrl?: string | null;
  settlementReportUrl?: string | null;
  eligibleSales?: string | null;
  donationAmount?: string | null;
  forkupFee?: string | null;
  achAmount?: string | null;
};

export type RenderedBusinessEmail = {
  subject: string;
  body: string;
  emailType: string;
  templateKey: BusinessEmailTemplateKey;
};

const TRUST_NOT_ENROLLED =
  "You are not automatically enrolled, and nothing will be shown publicly for your business unless you choose to accept.";

function greeting(ctx: BusinessEmailContext): string {
  const name = (ctx.businessContactName || ctx.businessName || "there").trim();
  return `Hi ${name},`;
}

function purposeBlock(ctx: BusinessEmailContext): string {
  const purpose = (ctx.campaignPurpose || "").trim();
  return purpose || "Supporting their community through a local giveback campaign.";
}

/**
 * Format method types into Nick-style participation label.
 * Inputs: method types. Outputs: human-readable participation string.
 */
export function participationLabelFromMethods(methods: MethodType[]): string {
  if (!methods.length) return "Local giveback partnership";
  const labels = methods.map((m) => METHOD_LABELS[m] || m);
  return labels.join(" / ");
}

/**
 * Format campaign start/end/event into a single date label.
 * Inputs: optional ISO date-only strings. Outputs: display string.
 */
export function formatCampaignDateLabel(input: {
  startDate?: string | null;
  endDate?: string | null;
  eventDate?: string | null;
}): string {
  const event = input.eventDate?.trim();
  if (event) return event;
  const start = input.startDate?.trim();
  const end = input.endDate?.trim();
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return `Through ${end}`;
  return "Dates to be confirmed";
}

/** Email 1 — Initial Business Invitation */
export function renderInitialInvitation(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const subject = `${ctx.nonprofitName} invited ${ctx.businessName} to support their ForkUp campaign`;
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 2 — Reminder before response deadline */
export function renderInviteReminder(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const subject = `Reminder: ${ctx.nonprofitName} campaign invitation`;
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 3 — Business accepted confirmation */
export function renderAcceptedConfirmation(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const dash = ctx.dashboardUrl || ctx.reviewUrl;
  const subject = `You're confirmed for ${ctx.campaignTitle}`;
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 4 — Business declined confirmation */
export function renderDeclinedConfirmation(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const subject = "Thanks for your response";
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 5 — Accepted but missing info */
export function renderMissingInfo(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const finishUrl = ctx.dashboardUrl || ctx.reviewUrl;
  const subject = "Action needed: finish setting up your ForkUp campaign participation";
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 6 — Campaign launch kit ready */
export function renderLaunchKit(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const materials = ctx.materialsUrl || ctx.dashboardUrl || ctx.reviewUrl;
  const subject = "Your ForkUp campaign materials are ready";
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 7 — Campaign starting soon */
export function renderStartingSoon(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const dash = ctx.dashboardUrl || ctx.reviewUrl;
  const when = ctx.startOrEventDate || ctx.dateRangeLabel;
  const subject = `${ctx.campaignTitle} starts soon`;
  const body =
    `${greeting(ctx)}\n\n` +
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

/** Email 8 — Campaign closed / settlement ready */
export function renderSettlementReady(ctx: BusinessEmailContext): RenderedBusinessEmail {
  const report = ctx.settlementReportUrl || ctx.dashboardUrl || ctx.reviewUrl;
  const subject = `Settlement report ready for ${ctx.campaignTitle}`;
  const body =
    `${greeting(ctx)}\n\n` +
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

export function renderBusinessEmail(
  key: BusinessEmailTemplateKey,
  ctx: BusinessEmailContext,
): RenderedBusinessEmail {
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
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
