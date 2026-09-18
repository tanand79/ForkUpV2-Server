/**
 * Editable email template library (role-scoped).
 *
 * Purpose: CRUD + resolve org/fundraiser templates with optional campaign
 * override. System hardcoded templates remain the fallback.
 *
 * Resolve order: campaign override → scope default → system catalog.
 * Placeholders: {{nonprofitName}}, {{businessName}}, {{campaignTitle}}, etc.
 *
 * SMTP From address stays platform smtp_from; default_sender_user_id is optional.
 */
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import type { AuthUser } from "./auth";
import {
  renderBusinessEmail,
  type BusinessEmailContext,
  type BusinessEmailTemplateKey,
} from "./business-email-templates";

export type EmailTemplateScopeType = "nonprofit" | "business" | "fundraiser_user";

export type EmailTemplateRecord = {
  id: number | null;
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  campaignId: number | null;
  templateKey: string;
  name: string;
  subject: string;
  body: string;
  defaultSenderUserId: number | null;
  /** Custom From display name only (not email). Null = use sender person's name. */
  defaultFromName: string | null;
  isActive: boolean;
  source: "database" | "system";
  canEdit: boolean;
};

export type TemplatePlaceholderContext = Record<string, string | null | undefined>;

type DbRow = QueryResultRow & {
  id: number;
  scope_type: string;
  scope_id: number;
  campaign_id: number | null;
  template_key: string;
  name: string;
  subject: string;
  body: string;
  default_sender_user_id: number | null;
  default_from_name: string | null;
  is_active: boolean;
};

/** Catalog entries available per role (system defaults + custom). */
const NONPROFIT_SYSTEM_KEYS: {
  key: BusinessEmailTemplateKey | "custom";
  name: string;
}[] = [
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

const BUSINESS_SYSTEM_KEYS: { key: string; name: string }[] = [
  { key: "nonprofit_campaign_invitation", name: "Invite a nonprofit" },
  { key: "custom", name: "Custom message" },
];

const FUNDRAISER_SYSTEM_KEYS: { key: string; name: string }[] = [
  { key: "fundraiser_campaign_invitation", name: "Invite a nonprofit" },
  { key: "custom", name: "Custom message" },
];

const SAMPLE_CTX: BusinessEmailContext = {
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

function systemKeysForScope(scopeType: EmailTemplateScopeType) {
  if (scopeType === "nonprofit") return NONPROFIT_SYSTEM_KEYS;
  if (scopeType === "business") return BUSINESS_SYSTEM_KEYS;
  return FUNDRAISER_SYSTEM_KEYS;
}

function parseScopeType(value: unknown): EmailTemplateScopeType | null {
  if (value === "nonprofit" || value === "business" || value === "fundraiser_user") {
    return value;
  }
  return null;
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function mapRow(row: DbRow): EmailTemplateRecord {
  const fromName =
    typeof row.default_from_name === "string" ? row.default_from_name.trim() : "";
  return {
    id: Number(row.id),
    scopeType: row.scope_type as EmailTemplateScopeType,
    scopeId: Number(row.scope_id),
    campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
    templateKey: String(row.template_key),
    name: String(row.name),
    subject: String(row.subject),
    body: String(row.body),
    defaultSenderUserId:
      row.default_sender_user_id != null ? Number(row.default_sender_user_id) : null,
    defaultFromName: fromName || null,
    isActive: Boolean(row.is_active),
    source: "database",
    canEdit: true,
  };
}

/**
 * Replace {{key}} placeholders. Unknown keys left as-is.
 * Inputs: template string + context map. Outputs: interpolated string.
 */
export function applyTemplatePlaceholders(
  template: string,
  context: TemplatePlaceholderContext,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = context[key];
    if (v == null) return "";
    return String(v);
  });
}

export function businessContextToPlaceholders(
  ctx: BusinessEmailContext,
): TemplatePlaceholderContext {
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

function systemSubjectBody(
  scopeType: EmailTemplateScopeType,
  templateKey: string,
): { subject: string; body: string; name: string } | null {
  const catalog = systemKeysForScope(scopeType);
  const meta = catalog.find((c) => c.key === templateKey);
  if (!meta) return null;

  if (scopeType === "nonprofit" && templateKey !== "custom") {
    const rendered = renderBusinessEmail(
      templateKey as BusinessEmailTemplateKey,
      SAMPLE_CTX,
    );
    // Store placeholder-friendly versions derived from sample render keys.
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
        .replaceAll(
          SAMPLE_CTX.campaignPurpose || "",
          "{{campaignPurpose}}",
        ),
    };
  }

  if (templateKey === "nonprofit_campaign_invitation") {
    return {
      name: meta.name,
      subject:
        "{{businessName}} invited {{nonprofitName}} to a ForkUp campaign",
      body:
        `Hi {{nonprofitName}},\n\n` +
        `{{businessName}} would like to run a campaign with you on ForkUp.\n\n` +
        `Review and respond here:\n{{reviewUrl}}\n\n` +
        `— ForkUp`,
    };
  }

  if (templateKey === "fundraiser_campaign_invitation") {
    return {
      name: meta.name,
      subject:
        "{{fundraiserName}} proposed a ForkUp campaign for {{nonprofitName}}",
      body:
        `Hi {{nonprofitName}},\n\n` +
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

/**
 * Authz: platform admin, org member (NPO/business), or fundraiser self-scope.
 * Edit requires owner/admin/manager (not viewer) for orgs.
 */
export function assertEmailTemplateAccess(
  user: AuthUser,
  scopeType: EmailTemplateScopeType,
  scopeId: number,
  mode: "read" | "write",
): string | null {
  if (user.isPlatformAdmin) return null;

  if (scopeType === "fundraiser_user") {
    if (user.id !== scopeId) return "Not allowed to access this fundraiser template library";
    return null;
  }

  const orgType = scopeType === "nonprofit" ? "nonprofit" : "business";
  const membership = user.organizations.find(
    (o) => o.organizationType === orgType && o.organizationId === scopeId,
  );
  if (!membership) return "Not a member of this organization";
  if (mode === "write" && membership.role === "viewer") {
    return "Viewers cannot edit email templates";
  }
  return null;
}

async function loadDbTemplates(
  scopeType: EmailTemplateScopeType,
  scopeId: number,
  campaignId: number | null,
  client?: PoolClient,
): Promise<DbRow[]> {
  const db = client ?? pool;
  if (campaignId != null) {
    const { rows } = await db.query<DbRow>(
      `SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
         AND (campaign_id IS NULL OR campaign_id = $3)
       ORDER BY campaign_id NULLS LAST, template_key ASC`,
      [scopeType, scopeId, campaignId],
    );
    return rows;
  }
  const { rows } = await db.query<DbRow>(
    `SELECT * FROM email_templates
     WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
       AND campaign_id IS NULL
     ORDER BY template_key ASC`,
    [scopeType, scopeId],
  );
  return rows;
}

/**
 * Lists catalog for a scope: system keys merged with DB overrides.
 * When campaignId set, campaign rows win over org defaults for the same key.
 */
export async function listEmailTemplates(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  campaignId?: number | null;
  canEdit: boolean;
}): Promise<EmailTemplateRecord[]> {
  const campaignId = input.campaignId ?? null;
  const rows = await loadDbTemplates(input.scopeType, input.scopeId, campaignId);
  const byKey = new Map<string, DbRow>();
  for (const row of rows) {
    const key = String(row.template_key);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    // Prefer campaign-specific over org default.
    if (existing.campaign_id == null && row.campaign_id != null) {
      byKey.set(key, row);
    }
  }

  const out: EmailTemplateRecord[] = [];
  const seen = new Set<string>();

  for (const meta of systemKeysForScope(input.scopeType)) {
    seen.add(meta.key);
    const dbRow = byKey.get(meta.key);
    if (dbRow) {
      out.push({ ...mapRow(dbRow), canEdit: input.canEdit });
      continue;
    }
    const sys = systemSubjectBody(input.scopeType, meta.key);
    if (!sys) continue;
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

  // Extra custom DB rows (multiple customs allowed only as distinct keys later;
  // for now include any DB keys not in system catalog).
  for (const [key, row] of byKey) {
    if (seen.has(key)) continue;
    out.push({ ...mapRow(row), canEdit: input.canEdit });
  }

  return out;
}

/**
 * Resolves subject/body for a key: campaign DB → scope DB → system.
 */
export async function resolveEmailTemplate(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  templateKey: string;
  campaignId?: number | null;
}): Promise<{
  subject: string;
  body: string;
  name: string;
  defaultSenderUserId: number | null;
  defaultFromName: string | null;
  source: "database" | "system";
  id: number | null;
  campaignId: number | null;
} | null> {
  const campaignId = input.campaignId ?? null;
  const db = pool;

  if (campaignId != null) {
    const { rows } = await db.query<DbRow>(
      `SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id = $4 AND is_active = TRUE
       LIMIT 1`,
      [input.scopeType, input.scopeId, input.templateKey, campaignId],
    );
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

  const { rows: defaults } = await db.query<DbRow>(
    `SELECT * FROM email_templates
     WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
       AND campaign_id IS NULL AND is_active = TRUE
     LIMIT 1`,
    [input.scopeType, input.scopeId, input.templateKey],
  );
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
  if (!sys) return null;
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

/**
 * When a nonprofit lifecycle email is about to send, prefer DB override if present.
 * Inputs: nonprofitId, campaignId, templateKey, rendered system email, business context.
 * Outputs: subject/body (possibly overridden + placeholders applied).
 */
export async function applyNonprofitTemplateOverride(input: {
  nonprofitId: number;
  campaignId: number;
  templateKey: BusinessEmailTemplateKey;
  fallbackSubject: string;
  fallbackBody: string;
  context: BusinessEmailContext;
}): Promise<{ subject: string; body: string; usedDatabase: boolean }> {
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

export async function upsertEmailTemplate(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  campaignId?: number | null;
  templateKey: string;
  name: string;
  subject: string;
  body: string;
  defaultSenderUserId?: number | null;
  /** Custom From display name only (not email). */
  defaultFromName?: string | null;
  userId: number;
}): Promise<EmailTemplateRecord> {
  const campaignId = input.campaignId ?? null;
  const name = input.name.trim() || input.templateKey;
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || !body) {
    throw new Error("subject and body are required");
  }
  const templateKey = input.templateKey.trim().slice(0, 60);
  if (!templateKey) throw new Error("templateKey is required");

  const senderId =
    input.defaultSenderUserId != null && input.defaultSenderUserId > 0
      ? input.defaultSenderUserId
      : null;
  const fromName =
    typeof input.defaultFromName === "string" && input.defaultFromName.trim()
      ? input.defaultFromName.trim().slice(0, 255)
      : null;

  // Soft-deactivate prior active row for same uniqueness key, then insert.
  if (campaignId == null) {
    await pool.query(
      `UPDATE email_templates
       SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $4
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id IS NULL AND is_active = TRUE`,
      [input.scopeType, input.scopeId, templateKey, input.userId],
    );
  } else {
    await pool.query(
      `UPDATE email_templates
       SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $5
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id = $4 AND is_active = TRUE`,
      [input.scopeType, input.scopeId, templateKey, campaignId, input.userId],
    );
  }

  const { rows } = await pool.query<DbRow>(
    `INSERT INTO email_templates (
      scope_type, scope_id, campaign_id, template_key, name, subject, body,
      default_sender_user_id, default_from_name, is_active,
      created_by_user_id, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $10)
    RETURNING *`,
    [
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
    ],
  );
  return { ...mapRow(rows[0]), canEdit: true };
}

export async function deactivateEmailTemplate(
  id: number,
  userId: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE email_templates
     SET is_active = FALSE, updated_at = NOW(), updated_by_user_id = $2
     WHERE id = $1 AND is_active = TRUE`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getEmailTemplateById(
  id: number,
): Promise<EmailTemplateRecord | null> {
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM email_templates WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export { parseScopeType, parsePositiveInt, SAMPLE_CTX as EMAIL_TEMPLATE_SAMPLE_CONTEXT };
