"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMAIL_TEMPLATE_SAMPLE_CONTEXT = void 0;
exports.applyTemplatePlaceholders = applyTemplatePlaceholders;
exports.businessContextToPlaceholders = businessContextToPlaceholders;
exports.assertEmailTemplateAccess = assertEmailTemplateAccess;
exports.listEmailTemplates = listEmailTemplates;
exports.resolveEmailTemplate = resolveEmailTemplate;
exports.applyNonprofitTemplateOverride = applyNonprofitTemplateOverride;
exports.upsertEmailTemplate = upsertEmailTemplate;
exports.deactivateEmailTemplate = deactivateEmailTemplate;
exports.getEmailTemplateById = getEmailTemplateById;
exports.parseScopeType = parseScopeType;
exports.parsePositiveInt = parsePositiveInt;
const pool_1 = require("../db/pool");
const business_email_templates_1 = require("./business-email-templates");
const NONPROFIT_SYSTEM_KEYS = [
    { key: "initial_invitation", name: "Business invitation" },
    { key: "invite_reminder", name: "Invite reminder" },
    { key: "accepted_confirmation", name: "Acceptance confirmation" },
    { key: "declined_confirmation", name: "Decline confirmation" },
    { key: "missing_info", name: "Missing info nudge" },
    { key: "launch_kit", name: "Launch kit ready" },
    { key: "starting_soon", name: "Starting soon" },
    { key: "settlement_ready", name: "Settlement ready" },
    { key: "custom", name: "Custom message" },
];
const BUSINESS_SYSTEM_KEYS = [
    { key: "nonprofit_campaign_invitation", name: "Invite a nonprofit" },
    { key: "custom", name: "Custom message" },
];
const FUNDRAISER_SYSTEM_KEYS = [
    { key: "fundraiser_campaign_invitation", name: "Invite a nonprofit" },
    { key: "custom", name: "Custom message" },
];
const SAMPLE_CTX = {
    businessName: "Sample Business",
    businessContactName: "Alex",
    nonprofitName: "Sample Nonprofit",
    campaignTitle: "Sample Campaign",
    campaignPurpose: "Supporting our community through local giveback.",
    participationLabel: "Dine & Donate",
    dateRangeLabel: "2026-10-01 – 2026-10-31",
    respondByDate: "2026-09-20",
    startOrEventDate: "2026-10-01",
    reviewUrl: "https://example.com/invite",
    dashboardUrl: "https://example.com/dashboard",
    materialsUrl: "https://example.com/materials",
    settlementReportUrl: "https://example.com/settlement",
    eligibleSales: "$1,000.00",
    donationAmount: "$100.00",
    forkupFee: "$15.00",
    achAmount: "$15.00",
};
exports.EMAIL_TEMPLATE_SAMPLE_CONTEXT = SAMPLE_CTX;
function systemKeysForScope(scopeType) {
    if (scopeType === "nonprofit")
        return NONPROFIT_SYSTEM_KEYS;
    if (scopeType === "business")
        return BUSINESS_SYSTEM_KEYS;
    return FUNDRAISER_SYSTEM_KEYS;
}
function parseScopeType(value) {
    if (value === "nonprofit" || value === "business" || value === "fundraiser_user") {
        return value;
    }
    return null;
}
function parsePositiveInt(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return Math.floor(n);
}
function mapRow(row) {
    const fromName = typeof row.default_from_name === "string" ? row.default_from_name.trim() : "";
    return {
        id: Number(row.id),
        scopeType: row.scope_type,
        scopeId: Number(row.scope_id),
        campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
        templateKey: String(row.template_key),
        name: String(row.name),
        subject: String(row.subject),
        body: String(row.body),
        defaultSenderUserId: row.default_sender_user_id != null ? Number(row.default_sender_user_id) : null,
        defaultFromName: fromName || null,
        isActive: Boolean(row.is_active),
        source: "database",
        canEdit: true,
    };
}
function applyTemplatePlaceholders(template, context) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
        const v = context[key];
        if (v == null)
            return "";
        return String(v);
    });
}
function businessContextToPlaceholders(ctx) {
    return {
        businessName: ctx.businessName,
        businessContactName: ctx.businessContactName ?? ctx.businessName,
        nonprofitName: ctx.nonprofitName,
        campaignTitle: ctx.campaignTitle,
        campaignPurpose: ctx.campaignPurpose ?? "",
        participationLabel: ctx.participationLabel,
        dateRangeLabel: ctx.dateRangeLabel,
        respondByDate: ctx.respondByDate ?? "",
        startOrEventDate: ctx.startOrEventDate ?? ctx.dateRangeLabel,
        reviewUrl: ctx.reviewUrl,
        dashboardUrl: ctx.dashboardUrl ?? ctx.reviewUrl,
        materialsUrl: ctx.materialsUrl ?? ctx.dashboardUrl ?? ctx.reviewUrl,
        settlementReportUrl: ctx.settlementReportUrl ?? ctx.dashboardUrl ?? ctx.reviewUrl,
        eligibleSales: ctx.eligibleSales ?? "",
        donationAmount: ctx.donationAmount ?? "",
        forkupFee: ctx.forkupFee ?? "",
        achAmount: ctx.achAmount ?? "",
    };
}
function systemSubjectBody(scopeType, templateKey) {
    const catalog = systemKeysForScope(scopeType);
    const meta = catalog.find((c) => c.key === templateKey);
    if (!meta)
        return null;
    if (scopeType === "nonprofit" && templateKey !== "custom") {
        const rendered = (0, business_email_templates_1.renderBusinessEmail)(templateKey, SAMPLE_CTX);
        return {
            name: meta.name,
            subject: rendered.subject
                .replace(SAMPLE_CTX.nonprofitName, "{{nonprofitName}}")
                .replace(SAMPLE_CTX.businessName, "{{businessName}}")
                .replace(SAMPLE_CTX.campaignTitle, "{{campaignTitle}}"),
            body: rendered.body
                .replaceAll(SAMPLE_CTX.nonprofitName, "{{nonprofitName}}")
                .replaceAll(SAMPLE_CTX.businessName, "{{businessName}}")
                .replaceAll(SAMPLE_CTX.businessContactName || "Alex", "{{businessContactName}}")
                .replaceAll(SAMPLE_CTX.campaignTitle, "{{campaignTitle}}")
                .replaceAll(SAMPLE_CTX.participationLabel, "{{participationLabel}}")
                .replaceAll(SAMPLE_CTX.dateRangeLabel, "{{dateRangeLabel}}")
                .replaceAll(SAMPLE_CTX.respondByDate || "", "{{respondByDate}}")
                .replaceAll(SAMPLE_CTX.startOrEventDate || "", "{{startOrEventDate}}")
                .replaceAll(SAMPLE_CTX.reviewUrl, "{{reviewUrl}}")
                .replaceAll(SAMPLE_CTX.dashboardUrl || "", "{{dashboardUrl}}")
                .replaceAll(SAMPLE_CTX.materialsUrl || "", "{{materialsUrl}}")
                .replaceAll(SAMPLE_CTX.campaignPurpose || "", "{{campaignPurpose}}"),
        };
    }
    if (templateKey === "nonprofit_campaign_invitation") {
        return {
            name: meta.name,
            subject: "{{businessName}} invited {{nonprofitName}} to a ForkUp campaign",
            body: `Hi {{nonprofitName}},\n\n` +
                `{{businessName}} would like to run a campaign with you on ForkUp.\n\n` +
                `Review and respond here:\n{{reviewUrl}}\n\n` +
                `— ForkUp`,
        };
    }
    if (templateKey === "fundraiser_campaign_invitation") {
        return {
            name: meta.name,
            subject: "{{fundraiserName}} proposed a ForkUp campaign for {{nonprofitName}}",
            body: `Hi {{nonprofitName}},\n\n` +
                `{{fundraiserName}} wants to run a campaign with you on ForkUp:\n` +
                `"{{campaignTitle}}"\n\n` +
                `Review and respond here:\n{{reviewUrl}}\n\n` +
                `— ForkUp`,
        };
    }
    return {
        name: meta.name,
        subject: "Message from {{nonprofitName}}",
        body: `Hi {{businessContactName}},\n\nWrite your message here.\n\n{{reviewUrl}}\n`,
    };
}
function assertEmailTemplateAccess(user, scopeType, scopeId, mode) {
    if (user.isPlatformAdmin)
        return null;
    if (scopeType === "fundraiser_user") {
        if (user.id !== scopeId)
            return "Not allowed to access this fundraiser template library";
        return null;
    }
    const orgType = scopeType === "nonprofit" ? "nonprofit" : "business";
    const membership = user.organizations.find((o) => o.organizationType === orgType && o.organizationId === scopeId);
    if (!membership)
        return "Not a member of this organization";
    if (mode === "write" && membership.role === "viewer") {
        return "Viewers cannot edit email templates";
    }
    return null;
}
async function loadDbTemplates(scopeType, scopeId, campaignId, client) {
    const db = client ?? pool_1.pool;
    if (campaignId != null) {
        const { rows } = await db.query(`SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
         AND (campaign_id IS NULL OR campaign_id = $3)
       ORDER BY campaign_id NULLS LAST, template_key ASC`, [scopeType, scopeId, campaignId]);
        return rows;
    }
    const { rows } = await db.query(`SELECT * FROM email_templates
     WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
       AND campaign_id IS NULL
     ORDER BY template_key ASC`, [scopeType, scopeId]);
    return rows;
}
async function listEmailTemplates(input) {
    const campaignId = input.campaignId ?? null;
    const rows = await loadDbTemplates(input.scopeType, input.scopeId, campaignId);
    const byKey = new Map();
    for (const row of rows) {
        const key = String(row.template_key);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, row);
            continue;
        }
        if (existing.campaign_id == null && row.campaign_id != null) {
            byKey.set(key, row);
        }
    }
    const out = [];
    const seen = new Set();
    for (const meta of systemKeysForScope(input.scopeType)) {
        seen.add(meta.key);
        const dbRow = byKey.get(meta.key);
        if (dbRow) {
            out.push({ ...mapRow(dbRow), canEdit: input.canEdit });
            continue;
        }
        const sys = systemSubjectBody(input.scopeType, meta.key);
        if (!sys)
            continue;
        out.push({
            id: null,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            campaignId,
            templateKey: meta.key,
            name: sys.name,
            subject: sys.subject,
            body: sys.body,
            defaultSenderUserId: null,
            defaultFromName: null,
            isActive: true,
            source: "system",
            canEdit: input.canEdit,
        });
    }
    for (const [key, row] of byKey) {
        if (seen.has(key))
            continue;
        out.push({ ...mapRow(row), canEdit: input.canEdit });
    }
    return out;
}
async function resolveEmailTemplate(input) {
    const campaignId = input.campaignId ?? null;
    const db = pool_1.pool;
    if (campaignId != null) {
        const { rows } = await db.query(`SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id = $4 AND is_active = TRUE
       LIMIT 1`, [input.scopeType, input.scopeId, input.templateKey, campaignId]);
        if (rows[0]) {
            const r = mapRow(rows[0]);
            return {
                id: r.id,
                subject: r.subject,
                body: r.body,
                name: r.name,
                defaultSenderUserId: r.defaultSenderUserId,
                defaultFromName: r.defaultFromName,
                source: "database",
                campaignId: r.campaignId,
            };
        }
    }
    const { rows: defaults } = await db.query(`SELECT * FROM email_templates
     WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
       AND campaign_id IS NULL AND is_active = TRUE
     LIMIT 1`, [input.scopeType, input.scopeId, input.templateKey]);
    if (defaults[0]) {
        const r = mapRow(defaults[0]);
        return {
            id: r.id,
            subject: r.subject,
            body: r.body,
            name: r.name,
            defaultSenderUserId: r.defaultSenderUserId,
            defaultFromName: r.defaultFromName,
            source: "database",
            campaignId: null,
        };
    }
    const sys = systemSubjectBody(input.scopeType, input.templateKey);
    if (!sys)
        return null;
    return {
        id: null,
        subject: sys.subject,
        body: sys.body,
        name: sys.name,
        defaultSenderUserId: null,
        defaultFromName: null,
        source: "system",
        campaignId,
    };
}
async function applyNonprofitTemplateOverride(input) {
    const resolved = await resolveEmailTemplate({
        scopeType: "nonprofit",
        scopeId: input.nonprofitId,
        templateKey: input.templateKey,
        campaignId: input.campaignId,
    });
    if (!resolved || resolved.source !== "database") {
        return {
            subject: input.fallbackSubject,
            body: input.fallbackBody,
            usedDatabase: false,
        };
    }
    const placeholders = businessContextToPlaceholders(input.context);
    return {
        subject: applyTemplatePlaceholders(resolved.subject, placeholders),
        body: applyTemplatePlaceholders(resolved.body, placeholders),
        usedDatabase: true,
    };
}
async function upsertEmailTemplate(input) {
    const campaignId = input.campaignId ?? null;
    const name = input.name.trim() || input.templateKey;
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (!subject || !body) {
        throw new Error("subject and body are required");
    }
    const templateKey = input.templateKey.trim().slice(0, 60);
    if (!templateKey)
        throw new Error("templateKey is required");
    const senderId = input.defaultSenderUserId != null && input.defaultSenderUserId > 0
        ? input.defaultSenderUserId
        : null;
    const fromName = typeof input.defaultFromName === "string" && input.defaultFromName.trim()
        ? input.defaultFromName.trim().slice(0, 255)
        : null;
    if (campaignId == null) {
        await pool_1.pool.query(`UPDATE email_templates
       SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $4
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id IS NULL AND is_active = TRUE`, [input.scopeType, input.scopeId, templateKey, input.userId]);
    }
    else {
        await pool_1.pool.query(`UPDATE email_templates
       SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $5
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id = $4 AND is_active = TRUE`, [input.scopeType, input.scopeId, templateKey, campaignId, input.userId]);
    }
    const { rows } = await pool_1.pool.query(`INSERT INTO email_templates (
      scope_type, scope_id, campaign_id, template_key, name, subject, body,
      default_sender_user_id, default_from_name, is_active,
      created_by_user_id, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $10)
    RETURNING *`, [
        input.scopeType,
        input.scopeId,
        campaignId,
        templateKey,
        name.slice(0, 255),
        subject.slice(0, 500),
        body,
        senderId,
        fromName,
        input.userId,
    ]);
    return { ...mapRow(rows[0]), canEdit: true };
}
async function deactivateEmailTemplate(id, userId) {
    const { rowCount } = await pool_1.pool.query(`UPDATE email_templates
     SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $2
     WHERE id = $1 AND is_active = TRUE`, [id, userId]);
    return (rowCount ?? 0) > 0;
}
async function getEmailTemplateById(id) {
    const { rows } = await pool_1.pool.query(`SELECT * FROM email_templates WHERE id = $1 LIMIT 1`, [id]);
    if (!rows[0])
        return null;
    return mapRow(rows[0]);
}
//# sourceMappingURL=email-templates.js.map