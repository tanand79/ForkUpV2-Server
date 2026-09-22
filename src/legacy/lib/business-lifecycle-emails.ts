/**
 * Nick V2 Layer 5 — Send business lifecycle emails (templates 1–8 helpers).
 *
 * Purpose: Load invite/campaign context and send via mailer with onlyOnce dedupe.
 * Inputs: campaignId / cbl id / template key. Outputs: send counts.
 */

import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { toDateOnlyString } from "./date-only";
import { sendEmail, resolveFrontendBaseUrl } from "./mailer";
import {
  loadCampaignInviteSender,
  type InviteSenderHeaders,
} from "./invite-sender";
import { METHOD_LABELS } from "./methods";
import type { MethodType } from "../types/campaign";
import {
  formatCampaignDateLabel,
  participationLabelFromMethods,
  renderAcceptedConfirmation,
  renderDeclinedConfirmation,
  renderInitialInvitation,
  renderInviteReminder,
  renderLaunchKit,
  renderMissingInfo,
  renderSettlementReady,
  renderStartingSoon,
  type BusinessEmailContext,
  type BusinessEmailTemplateKey,
} from "./business-email-templates";
import { applyNonprofitTemplateOverride } from "./email-templates";

export type LifecycleSendResult = {
  sent: number;
  skipped: number;
  targeted: number;
};

type PartnerRow = QueryResultRow & {
  cbl_id: number;
  token: string | null;
  acceptance_status: string;
  invite_status: string | null;
  setup_status: string | null;
  marketing_ready_status: string | null;
  settlement_ready_status: string | null;
  respond_by_date: string | Date | null;
  giveback_percentage: number | string | null;
  business_name: string;
  contact_name: string | null;
  contact_email: string | null;
  method_type: string | null;
  campaign_name: string;
  campaign_story: string | null;
  campaign_slug: string;
  campaign_start_date: string | Date | null;
  campaign_end_date: string | Date | null;
  event_date: string | Date | null;
  organization_name: string;
  nonprofit_id: number;
};

function money(n: number): string {
  return `$${Number(n || 0).toFixed(2)}`;
}

function purposeSnippet(story: string | null | undefined): string {
  const t = (story || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > 280 ? `${t.slice(0, 277)}…` : t;
}

function buildUrls(token: string | null, campaignSlug: string) {
  const base = resolveFrontendBaseUrl();
  const reviewUrl = token
    ? `${base}/?step=business-acceptance&token=${token}`
    : `${base}/?step=business-dashboard&campaign=${campaignSlug}`;
  const dashboardUrl = `${base}/?step=business-dashboard&campaign=${campaignSlug}`;
  const materialsUrl = `${base}/?step=success-engine&campaign=${campaignSlug}`;
  const settlementReportUrl = `${base}/?step=reporting&campaign=${campaignSlug}`;
  return { reviewUrl, dashboardUrl, materialsUrl, settlementReportUrl };
}

function rowToContext(row: PartnerRow): BusinessEmailContext | null {
  const email = typeof row.contact_email === "string" ? row.contact_email.trim() : "";
  if (!email) return null;
  const methods: MethodType[] = row.method_type
    ? [row.method_type as MethodType]
    : [];
  const urls = buildUrls(row.token, String(row.campaign_slug));
  const start = toDateOnlyString(row.campaign_start_date);
  const end = toDateOnlyString(row.campaign_end_date);
  const event = toDateOnlyString(row.event_date);
  return {
    businessName: String(row.business_name),
    businessContactName: row.contact_name,
    nonprofitName: String(row.organization_name),
    campaignTitle: String(row.campaign_name),
    campaignPurpose: purposeSnippet(row.campaign_story),
    participationLabel: methods.length
      ? participationLabelFromMethods(methods)
      : METHOD_LABELS.dine_and_donate,
    dateRangeLabel: formatCampaignDateLabel({
      startDate: start,
      endDate: end,
      eventDate: event,
    }),
    respondByDate: toDateOnlyString(row.respond_by_date),
    startOrEventDate: event || start,
    ...urls,
  };
}

async function loadPartners(campaignId: number, cblId?: number): Promise<PartnerRow[]> {
  const params: unknown[] = [campaignId];
  let filter = "";
  if (cblId != null) {
    params.push(cblId);
    filter = ` AND cbl.id = $${params.length}`;
  }
  const { rows } = await pool.query<PartnerRow>(
    `SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name, n.id AS nonprofit_id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1${filter}
     ORDER BY cbl.id ASC`,
    params,
  );
  return rows;
}

/**
 * Prefer org/campaign DB template override when present; else system render.
 */
async function withTemplateOverride(
  campaignId: number,
  nonprofitId: number,
  rendered: { subject: string; body: string; emailType: string; templateKey: BusinessEmailTemplateKey },
  ctx: BusinessEmailContext,
  fromName?: string | null,
): Promise<{
  subject: string;
  body: string;
  emailType: string;
  defaultFromName: string | null;
}> {
  const overridden = await applyNonprofitTemplateOverride({
    nonprofitId,
    campaignId,
    templateKey: rendered.templateKey,
    fallbackSubject: rendered.subject,
    fallbackBody: rendered.body,
    context: ctx,
    fromName: fromName ?? null,
  });
  return {
    subject: overridden.subject,
    body: overridden.body,
    emailType: rendered.emailType,
    defaultFromName: overridden.defaultFromName,
  };
}

/** Merge campaign invite sender with optional template From display name. */
function mergeInviteSender(
  sender: InviteSenderHeaders | null | undefined,
  templateFromName: string | null | undefined,
): InviteSenderHeaders | null {
  const fromName =
    (sender?.fromName && sender.fromName.trim()) ||
    (typeof templateFromName === "string" && templateFromName.trim()) ||
    "";
  if (!fromName && !(sender?.replyTo && sender.replyTo.includes("@"))) {
    return sender ?? null;
  }
  return {
    userId: sender?.userId ?? 0,
    fromName: fromName || sender?.fromName || "ForkUp organizer",
    replyTo: sender?.replyTo ?? "",
  };
}

async function sendRendered(
  to: string,
  name: string,
  rendered: { subject: string; body: string; emailType: string },
  campaignId: number,
  relatedToken: string,
  onlyOnce = true,
  sender?: InviteSenderHeaders | null,
): Promise<"sent" | "skipped" | "failed"> {
  const result = await sendEmail({
    to,
    name,
    subject: rendered.subject,
    body: rendered.body,
    emailType: rendered.emailType,
    campaignId,
    stakeholderRole: "business",
    relatedToken,
    onlyOnce,
    // When set, wins over org-name enrichment (custom From and/or person Reply-To).
    ...(sender?.fromName ? { fromName: sender.fromName } : {}),
    ...(sender?.replyTo?.includes("@") ? { replyTo: sender.replyTo } : {}),
  });
  if (result.status === "sent") return "sent";
  if (result.status === "skipped") return "skipped";
  return "failed";
}

/**
 * Email 1 — send initial invitation for invited rows (builder launch path).
 * Keeps emailType business_campaign_invitation for existing log/dedupe.
 */
export async function sendInitialInvitationEmails(
  campaignId: number,
  options?: { onlyStatus?: string[]; /** Optional: only this partner CBL row */ cblId?: number },
): Promise<LifecycleSendResult> {
  const allowed = options?.onlyStatus ?? ["invited"];
  const rows = await loadPartners(campaignId, options?.cblId);
  const sender = await loadCampaignInviteSender(campaignId);
  let sent = 0;
  let skipped = 0;
  let targeted = 0;
  for (const row of rows) {
    if (!allowed.includes(String(row.acceptance_status))) continue;
    const ctx = rowToContext(row);
    if (!ctx || !row.token) {
      skipped += 1;
      continue;
    }
    targeted += 1;
    const email = String(row.contact_email).trim();
    const rendered = renderInitialInvitation(ctx);
    const finalRendered = await withTemplateOverride(
      campaignId,
      Number(row.nonprofit_id),
      rendered,
      ctx,
      sender?.fromName,
    );
    const status = await sendRendered(
      email,
      ctx.businessName,
      finalRendered,
      campaignId,
      row.token,
      true,
      mergeInviteSender(sender, finalRendered.defaultFromName),
    );
    if (status === "sent") sent += 1;
    else skipped += 1;
  }
  return { sent, skipped, targeted };
}

/** Email 3 — business accepted confirmation (additive; nonprofit notify stays separate). */
export async function sendBusinessAcceptedConfirmation(
  campaignId: number,
  businessId: number,
): Promise<void> {
  const { rows } = await pool.query<PartnerRow>(
    `SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name, n.id AS nonprofit_id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1 AND cbl.business_id = $2
     ORDER BY cbl.id DESC
     LIMIT 1`,
    [campaignId, businessId],
  );
  const row = rows[0];
  if (!row) return;
  const ctx = rowToContext(row);
  if (!ctx) return;
  const email = String(row.contact_email).trim();
  const rendered = renderAcceptedConfirmation(ctx);
  const sender = await loadCampaignInviteSender(campaignId);
  const finalRendered = await withTemplateOverride(
    campaignId,
    Number(row.nonprofit_id),
    rendered,
    ctx,
    sender?.fromName,
  );
  await sendRendered(
    email,
    ctx.businessName,
    finalRendered,
    campaignId,
    `biz-email-3:${row.cbl_id}`,
    true,
    mergeInviteSender(sender, finalRendered.defaultFromName),
  );
}

/** Email 4 — business declined confirmation. */
export async function sendBusinessDeclinedConfirmation(
  campaignId: number,
  businessId: number,
): Promise<void> {
  const { rows } = await pool.query<PartnerRow>(
    `SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name, n.id AS nonprofit_id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1 AND cbl.business_id = $2
     ORDER BY cbl.id DESC
     LIMIT 1`,
    [campaignId, businessId],
  );
  const row = rows[0];
  if (!row) return;
  const ctx = rowToContext(row);
  if (!ctx) return;
  const email = String(row.contact_email).trim();
  const rendered = renderDeclinedConfirmation(ctx);
  const sender = await loadCampaignInviteSender(campaignId);
  const finalRendered = await withTemplateOverride(
    campaignId,
    Number(row.nonprofit_id),
    rendered,
    ctx,
    sender?.fromName,
  );
  await sendRendered(
    email,
    ctx.businessName,
    finalRendered,
    campaignId,
    `biz-email-4:${row.cbl_id}`,
    true,
    mergeInviteSender(sender, finalRendered.defaultFromName),
  );
}

function matchesTemplateAudience(
  key: Extract<
    BusinessEmailTemplateKey,
    "invite_reminder" | "missing_info" | "launch_kit" | "starting_soon"
  >,
  row: PartnerRow,
): boolean {
  const status = String(row.acceptance_status);
  if (key === "invite_reminder") {
    return ["invited", "opened", "pending"].includes(status);
  }
  if (key === "missing_info") {
    if (!["accepted", "needs_info", "ready"].includes(status)) return false;
    return (
      String(row.setup_status) === "needs_info" ||
      String(row.settlement_ready_status) === "needs_info" ||
      String(row.invite_status) === "needs_info"
    );
  }
  if (key === "launch_kit") {
    return ["accepted", "ready", "live"].includes(status);
  }
  if (key === "starting_soon") {
    return ["accepted", "ready", "live"].includes(status);
  }
  return false;
}

/**
 * Batch-send Emails 2 / 5 / 6 / 7 for a campaign (optional single invitation).
 * Method used by manage route.
 */
export async function sendBusinessLifecycleBatch(input: {
  campaignId: number;
  templateKey: "invite_reminder" | "missing_info" | "launch_kit" | "starting_soon";
  invitationId?: number;
}): Promise<LifecycleSendResult> {
  const rows = await loadPartners(input.campaignId, input.invitationId);
  const sender = await loadCampaignInviteSender(input.campaignId);
  let sent = 0;
  let skipped = 0;
  let targeted = 0;

  for (const row of rows) {
    if (!matchesTemplateAudience(input.templateKey, row)) {
      skipped += 1;
      continue;
    }
    const ctx = rowToContext(row);
    if (!ctx) {
      skipped += 1;
      continue;
    }
    targeted += 1;
    const email = String(row.contact_email).trim();
    const rendered =
      input.templateKey === "invite_reminder"
        ? renderInviteReminder(ctx)
        : input.templateKey === "missing_info"
          ? renderMissingInfo(ctx)
          : input.templateKey === "launch_kit"
            ? renderLaunchKit(ctx)
            : renderStartingSoon(ctx);
    const finalRendered = await withTemplateOverride(
      input.campaignId,
      Number(row.nonprofit_id),
      rendered,
      ctx,
      sender?.fromName,
    );
    const tokenKey = `biz-email-${input.templateKey}:${row.cbl_id}`;
    const status = await sendRendered(
      email,
      ctx.businessName,
      finalRendered,
      input.campaignId,
      tokenKey,
      true,
      mergeInviteSender(sender, finalRendered.defaultFromName),
    );
    if (status === "sent") sent += 1;
    else skipped += 1;
  }

  return { sent, skipped, targeted };
}

/**
 * Email 8 helper — render Nick settlement copy for one business row.
 * Used by manage sendSettlementEmails (keeps emailType settlement_business).
 */
export function buildSettlementBusinessEmail(input: {
  businessName: string;
  nonprofitName: string;
  campaignTitle: string;
  dateRangeLabel: string;
  eligibleSales: number;
  donationAmount: number;
  forkupFee: number;
  reportUrl: string;
}): ReturnType<typeof renderSettlementReady> {
  return renderSettlementReady({
    businessName: input.businessName,
    nonprofitName: input.nonprofitName,
    campaignTitle: input.campaignTitle,
    campaignPurpose: null,
    participationLabel: "Campaign partner",
    dateRangeLabel: input.dateRangeLabel,
    reviewUrl: input.reportUrl,
    settlementReportUrl: input.reportUrl,
    eligibleSales: money(input.eligibleSales),
    donationAmount: money(input.donationAmount),
    forkupFee: money(input.forkupFee),
    achAmount: money(input.forkupFee),
  });
}
