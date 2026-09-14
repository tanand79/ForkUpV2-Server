"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendInitialInvitationEmails = sendInitialInvitationEmails;
exports.sendBusinessAcceptedConfirmation = sendBusinessAcceptedConfirmation;
exports.sendBusinessDeclinedConfirmation = sendBusinessDeclinedConfirmation;
exports.sendBusinessLifecycleBatch = sendBusinessLifecycleBatch;
exports.buildSettlementBusinessEmail = buildSettlementBusinessEmail;
const pool_1 = require("../db/pool");
const date_only_1 = require("./date-only");
const mailer_1 = require("./mailer");
const methods_1 = require("./methods");
const business_email_templates_1 = require("./business-email-templates");
function money(n) {
    return `$${Number(n || 0).toFixed(2)}`;
}
function purposeSnippet(story) {
    const t = (story || "").trim().replace(/\s+/g, " ");
    if (!t)
        return "";
    return t.length > 280 ? `${t.slice(0, 277)}…` : t;
}
function buildUrls(token, campaignSlug) {
    const base = (0, mailer_1.resolveFrontendBaseUrl)();
    const reviewUrl = token
        ? `${base}/?step=business-acceptance&token=${token}`
        : `${base}/?step=business-dashboard&campaign=${campaignSlug}`;
    const dashboardUrl = `${base}/?step=business-dashboard&campaign=${campaignSlug}`;
    const materialsUrl = `${base}/?step=success-engine&campaign=${campaignSlug}`;
    const settlementReportUrl = `${base}/?step=reporting&campaign=${campaignSlug}`;
    return { reviewUrl, dashboardUrl, materialsUrl, settlementReportUrl };
}
function rowToContext(row) {
    const email = typeof row.contact_email === "string" ? row.contact_email.trim() : "";
    if (!email)
        return null;
    const methods = row.method_type
        ? [row.method_type]
        : [];
    const urls = buildUrls(row.token, String(row.campaign_slug));
    const start = (0, date_only_1.toDateOnlyString)(row.campaign_start_date);
    const end = (0, date_only_1.toDateOnlyString)(row.campaign_end_date);
    const event = (0, date_only_1.toDateOnlyString)(row.event_date);
    return {
        businessName: String(row.business_name),
        businessContactName: row.contact_name,
        nonprofitName: String(row.organization_name),
        campaignTitle: String(row.campaign_name),
        campaignPurpose: purposeSnippet(row.campaign_story),
        participationLabel: methods.length
            ? (0, business_email_templates_1.participationLabelFromMethods)(methods)
            : methods_1.METHOD_LABELS.dine_and_donate,
        dateRangeLabel: (0, business_email_templates_1.formatCampaignDateLabel)({
            startDate: start,
            endDate: end,
            eventDate: event,
        }),
        respondByDate: (0, date_only_1.toDateOnlyString)(row.respond_by_date),
        startOrEventDate: event || start,
        ...urls,
    };
}
async function loadPartners(campaignId, cblId) {
    const params = [campaignId];
    let filter = "";
    if (cblId != null) {
        params.push(cblId);
        filter = ` AND cbl.id = $${params.length}`;
    }
    const { rows } = await pool_1.pool.query(`SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1${filter}
     ORDER BY cbl.id ASC`, params);
    return rows;
}
async function sendRendered(to, name, rendered, campaignId, relatedToken, onlyOnce = true) {
    const result = await (0, mailer_1.sendEmail)({
        to,
        name,
        subject: rendered.subject,
        body: rendered.body,
        emailType: rendered.emailType,
        campaignId,
        stakeholderRole: "business",
        relatedToken,
        onlyOnce,
    });
    if (result.status === "sent")
        return "sent";
    if (result.status === "skipped")
        return "skipped";
    return "failed";
}
async function sendInitialInvitationEmails(campaignId, options) {
    const allowed = options?.onlyStatus ?? ["invited"];
    const rows = await loadPartners(campaignId);
    let sent = 0;
    let skipped = 0;
    let targeted = 0;
    for (const row of rows) {
        if (!allowed.includes(String(row.acceptance_status)))
            continue;
        const ctx = rowToContext(row);
        if (!ctx || !row.token) {
            skipped += 1;
            continue;
        }
        targeted += 1;
        const email = String(row.contact_email).trim();
        const rendered = (0, business_email_templates_1.renderInitialInvitation)(ctx);
        const status = await sendRendered(email, ctx.businessName, rendered, campaignId, row.token, true);
        if (status === "sent")
            sent += 1;
        else
            skipped += 1;
    }
    return { sent, skipped, targeted };
}
async function sendBusinessAcceptedConfirmation(campaignId, businessId) {
    const { rows } = await pool_1.pool.query(`SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1 AND cbl.business_id = $2
     ORDER BY cbl.id DESC
     LIMIT 1`, [campaignId, businessId]);
    const row = rows[0];
    if (!row)
        return;
    const ctx = rowToContext(row);
    if (!ctx)
        return;
    const email = String(row.contact_email).trim();
    const rendered = (0, business_email_templates_1.renderAcceptedConfirmation)(ctx);
    await sendRendered(email, ctx.businessName, rendered, campaignId, `biz-email-3:${row.cbl_id}`, true);
}
async function sendBusinessDeclinedConfirmation(campaignId, businessId) {
    const { rows } = await pool_1.pool.query(`SELECT cbl.id AS cbl_id, it.token, cbl.acceptance_status, cbl.invite_status,
            cbl.setup_status, cbl.marketing_ready_status, cbl.settlement_ready_status,
            cbl.respond_by_date, cbl.giveback_percentage,
            b.business_name, b.contact_name, b.contact_email,
            cm.method_type,
            c.campaign_name, c.campaign_story, c.slug AS campaign_slug,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN campaigns c ON c.id = cbl.campaign_id
     JOIN nonprofits n ON n.id = c.nonprofit_id
     LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
     LEFT JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1 AND cbl.business_id = $2
     ORDER BY cbl.id DESC
     LIMIT 1`, [campaignId, businessId]);
    const row = rows[0];
    if (!row)
        return;
    const ctx = rowToContext(row);
    if (!ctx)
        return;
    const email = String(row.contact_email).trim();
    const rendered = (0, business_email_templates_1.renderDeclinedConfirmation)(ctx);
    await sendRendered(email, ctx.businessName, rendered, campaignId, `biz-email-4:${row.cbl_id}`, true);
}
function matchesTemplateAudience(key, row) {
    const status = String(row.acceptance_status);
    if (key === "invite_reminder") {
        return ["invited", "opened", "pending"].includes(status);
    }
    if (key === "missing_info") {
        if (!["accepted", "needs_info", "ready"].includes(status))
            return false;
        return (String(row.setup_status) === "needs_info" ||
            String(row.settlement_ready_status) === "needs_info" ||
            String(row.invite_status) === "needs_info");
    }
    if (key === "launch_kit") {
        return ["accepted", "ready", "live"].includes(status);
    }
    if (key === "starting_soon") {
        return ["accepted", "ready", "live"].includes(status);
    }
    return false;
}
async function sendBusinessLifecycleBatch(input) {
    const rows = await loadPartners(input.campaignId, input.invitationId);
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
        const rendered = input.templateKey === "invite_reminder"
            ? (0, business_email_templates_1.renderInviteReminder)(ctx)
            : input.templateKey === "missing_info"
                ? (0, business_email_templates_1.renderMissingInfo)(ctx)
                : input.templateKey === "launch_kit"
                    ? (0, business_email_templates_1.renderLaunchKit)(ctx)
                    : (0, business_email_templates_1.renderStartingSoon)(ctx);
        const tokenKey = `biz-email-${input.templateKey}:${row.cbl_id}`;
        const status = await sendRendered(email, ctx.businessName, rendered, input.campaignId, tokenKey, true);
        if (status === "sent")
            sent += 1;
        else
            skipped += 1;
    }
    return { sent, skipped, targeted };
}
function buildSettlementBusinessEmail(input) {
    return (0, business_email_templates_1.renderSettlementReady)({
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
//# sourceMappingURL=business-lifecycle-emails.js.map