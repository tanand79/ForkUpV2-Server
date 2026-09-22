/**
 * Editable email template library (role-scoped).
 *
 * Purpose: CRUD + resolve org/fundraiser templates with optional campaign
 * override. System hardcoded templates remain the fallback.
 *
 * Resolve for send (with fromName): person variant by base_template_key +
 * default_from_name → else system catalog.
 * Resolve for UI (exact templateKey): that row → else system.
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
  /** System catalog key this variant belongs to (e.g. nonprofit_campaign_invitation). */
  baseTemplateKey: string | null;
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
  base_template_key: string | null;
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
  const baseKey =
    typeof row.base_template_key === "string" ? row.base_template_key.trim() : "";
  return {
    id: Number(row.id),
    scopeType: row.scope_type as EmailTemplateScopeType,
    scopeId: Number(row.scope_id),
    campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
    templateKey: String(row.template_key),
    baseTemplateKey: baseKey || String(row.template_key),
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

function isCatalogKey(
  scopeType: EmailTemplateScopeType,
  templateKey: string,
): boolean {
  return systemKeysForScope(scopeType).some((c) => c.key === templateKey);
}

function slugifyFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slug || "user";
}

/** Builds a unique template_key for a person variant under a system base key. */
function makeVariantTemplateKey(baseKey: string, fromName: string): string {
  return `${baseKey}__${slugifyFromName(fromName)}`.slice(0, 60);
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
 * Lists catalog for a scope: system keys always, plus every active DB variant.
 * Variants are matched at send time by base_template_key + From name.
 */
export async function listEmailTemplates(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  campaignId?: number | null;
  canEdit: boolean;
}): Promise<EmailTemplateRecord[]> {
  const campaignId = input.campaignId ?? null;
  const rows = await loadDbTemplates(input.scopeType, input.scopeId, campaignId);
  const out: EmailTemplateRecord[] = [];

  for (const meta of systemKeysForScope(input.scopeType)) {
    const sys = systemSubjectBody(input.scopeType, meta.key);
    if (!sys) continue;
    out.push({
      id: null,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      campaignId,
      templateKey: meta.key,
      baseTemplateKey: meta.key,
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

  for (const row of rows) {
    out.push({ ...mapRow(row), canEdit: input.canEdit });
  }

  return out;
}

function systemFallback(
  scopeType: EmailTemplateScopeType,
  templateKey: string,
  campaignId: number | null,
): {
  subject: string;
  body: string;
  name: string;
  defaultSenderUserId: number | null;
  defaultFromName: string | null;
  source: "system";
  id: null;
  campaignId: number | null;
  baseTemplateKey: string;
} | null {
  const sys = systemSubjectBody(scopeType, templateKey);
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
    baseTemplateKey: templateKey,
  };
}

/**
 * Resolves subject/body for a key.
 * When fromName is set (invite send): match base_template_key + From name → else system.
 * When fromName omitted (UI / exact key): exact template_key row → else system.
 */
export async function resolveEmailTemplate(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  templateKey: string;
  campaignId?: number | null;
  /** When set, pick the person variant for this From name under the base key. */
  fromName?: string | null;
}): Promise<{
  subject: string;
  body: string;
  name: string;
  defaultSenderUserId: number | null;
  defaultFromName: string | null;
  source: "database" | "system";
  id: number | null;
  campaignId: number | null;
  baseTemplateKey: string | null;
} | null> {
  const campaignId = input.campaignId ?? null;
  const templateKey = input.templateKey.trim();
  if (!templateKey) return null;
  const fromName =
    typeof input.fromName === "string" && input.fromName.trim()
      ? input.fromName.trim()
      : "";

  if (fromName) {
    const baseKey = isCatalogKey(input.scopeType, templateKey)
      ? templateKey
      : templateKey;
    const matchParams = [
      input.scopeType,
      input.scopeId,
      baseKey,
      fromName.toLowerCase(),
    ] as const;

    if (campaignId != null) {
      const { rows } = await pool.query<DbRow>(
        `SELECT * FROM email_templates
         WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
           AND campaign_id = $5
           AND COALESCE(NULLIF(trim(base_template_key), ''), template_key) = $3
           AND lower(trim(default_from_name)) = $4
         ORDER BY id DESC
         LIMIT 1`,
        [...matchParams, campaignId],
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
          baseTemplateKey: r.baseTemplateKey,
        };
      }
    }

    const { rows: orgRows } = await pool.query<DbRow>(
      `SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
         AND campaign_id IS NULL
         AND COALESCE(NULLIF(trim(base_template_key), ''), template_key) = $3
         AND lower(trim(default_from_name)) = $4
       ORDER BY id DESC
       LIMIT 1`,
      [...matchParams],
    );
    if (orgRows[0]) {
      const r = mapRow(orgRows[0]);
      return {
        id: r.id,
        subject: r.subject,
        body: r.body,
        name: r.name,
        defaultSenderUserId: r.defaultSenderUserId,
        defaultFromName: r.defaultFromName,
        source: "database",
        campaignId: null,
        baseTemplateKey: r.baseTemplateKey,
      };
    }

    return systemFallback(input.scopeType, baseKey, campaignId);
  }

  if (campaignId != null) {
    const { rows } = await pool.query<DbRow>(
      `SELECT * FROM email_templates
       WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
         AND campaign_id = $4 AND is_active = TRUE
       LIMIT 1`,
      [input.scopeType, input.scopeId, templateKey, campaignId],
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
        baseTemplateKey: r.baseTemplateKey,
      };
    }
  }

  const { rows: defaults } = await pool.query<DbRow>(
    `SELECT * FROM email_templates
     WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
       AND campaign_id IS NULL AND is_active = TRUE
     LIMIT 1`,
    [input.scopeType, input.scopeId, templateKey],
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
      baseTemplateKey: r.baseTemplateKey,
    };
  }

  return systemFallback(input.scopeType, templateKey, campaignId);
}

/**
 * When a nonprofit lifecycle email is about to send, prefer DB person variant
 * matching fromName; else system fallback copy.
 * Inputs: nonprofitId, campaignId, templateKey, fromName, rendered system email, business context.
 * Outputs: subject/body (possibly overridden + placeholders applied).
 */
export async function applyNonprofitTemplateOverride(input: {
  nonprofitId: number;
  campaignId: number;
  templateKey: BusinessEmailTemplateKey;
  fallbackSubject: string;
  fallbackBody: string;
  context: BusinessEmailContext;
  /** Campaign invite From name — selects which stored variant to use. */
  fromName?: string | null;
}): Promise<{
  subject: string;
  body: string;
  usedDatabase: boolean;
  defaultFromName: string | null;
}> {
  const fromName =
    typeof input.fromName === "string" && input.fromName.trim()
      ? input.fromName.trim()
      : "";
  const resolved = await resolveEmailTemplate({
    scopeType: "nonprofit",
    scopeId: input.nonprofitId,
    templateKey: input.templateKey,
    campaignId: input.campaignId,
    ...(fromName ? { fromName } : {}),
  });
  // With fromName: only database person variants count (system resolve = no match).
  // Without fromName: keep exact-key DB override if present.
  if (
    !resolved ||
    resolved.source !== "database" ||
    (fromName && !resolved.defaultFromName)
  ) {
    return {
      subject: input.fallbackSubject,
      body: input.fallbackBody,
      usedDatabase: false,
      defaultFromName: null,
    };
  }
  if (fromName) {
    // Ensure the row actually matched this From name (systemFallback has null).
    const matched =
      (resolved.defaultFromName || "").trim().toLowerCase() ===
      fromName.toLowerCase();
    if (!matched) {
      return {
        subject: input.fallbackSubject,
        body: input.fallbackBody,
        usedDatabase: false,
        defaultFromName: null,
      };
    }
  }
  const placeholders = businessContextToPlaceholders(input.context);
  return {
    subject: applyTemplatePlaceholders(resolved.subject, placeholders),
    body: applyTemplatePlaceholders(resolved.body, placeholders),
    usedDatabase: true,
    defaultFromName: resolved.defaultFromName,
  };
}

export async function upsertEmailTemplate(input: {
  scopeType: EmailTemplateScopeType;
  scopeId: number;
  campaignId?: number | null;
  templateKey: string;
  /** System catalog key for person variants. Defaults from templateKey when catalog. */
  baseTemplateKey?: string | null;
  name: string;
  subject: string;
  body: string;
  defaultSenderUserId?: number | null;
  /** Custom From display name only (not email). When set → person variant. */
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
  const rawKey = input.templateKey.trim().slice(0, 60);
  if (!rawKey) throw new Error("templateKey is required");

  const senderId =
    input.defaultSenderUserId != null && input.defaultSenderUserId > 0
      ? input.defaultSenderUserId
      : null;
  const fromName =
    typeof input.defaultFromName === "string" && input.defaultFromName.trim()
      ? input.defaultFromName.trim().slice(0, 255)
      : null;

  const catalogBase = isCatalogKey(input.scopeType, rawKey)
    ? rawKey
    : typeof input.baseTemplateKey === "string" && input.baseTemplateKey.trim()
      ? input.baseTemplateKey.trim().slice(0, 60)
      : rawKey.includes("__")
        ? rawKey.slice(0, rawKey.indexOf("__")).slice(0, 60)
        : rawKey;

  // Person variant: unique template_key, match at send by base + From name.
  if (fromName) {
    const baseKey =
      typeof input.baseTemplateKey === "string" && input.baseTemplateKey.trim()
        ? input.baseTemplateKey.trim().slice(0, 60)
        : catalogBase;

    const existingQuery =
      campaignId == null
        ? await pool.query<DbRow>(
            `SELECT * FROM email_templates
             WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
               AND campaign_id IS NULL
               AND COALESCE(NULLIF(trim(base_template_key), ''), template_key) = $3
               AND lower(trim(default_from_name)) = $4
             ORDER BY id DESC
             LIMIT 1`,
            [input.scopeType, input.scopeId, baseKey, fromName.toLowerCase()],
          )
        : await pool.query<DbRow>(
            `SELECT * FROM email_templates
             WHERE scope_type = $1 AND scope_id = $2 AND is_active = TRUE
               AND campaign_id = $5
               AND COALESCE(NULLIF(trim(base_template_key), ''), template_key) = $3
               AND lower(trim(default_from_name)) = $4
             ORDER BY id DESC
             LIMIT 1`,
            [
              input.scopeType,
              input.scopeId,
              baseKey,
              fromName.toLowerCase(),
              campaignId,
            ],
          );

    const existing = existingQuery.rows[0];
    let templateKey = existing
      ? String(existing.template_key)
      : makeVariantTemplateKey(baseKey, fromName);

    if (!existing) {
      // Avoid unique-index clash if slug already used for another from-name.
      const { rows: clash } = await pool.query<{ id: number }>(
        campaignId == null
          ? `SELECT id FROM email_templates
             WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
               AND campaign_id IS NULL AND is_active = TRUE
             LIMIT 1`
          : `SELECT id FROM email_templates
             WHERE scope_type = $1 AND scope_id = $2 AND template_key = $3
               AND campaign_id = $4 AND is_active = TRUE
             LIMIT 1`,
        campaignId == null
          ? [input.scopeType, input.scopeId, templateKey]
          : [input.scopeType, input.scopeId, templateKey, campaignId],
      );
      if (clash[0]) {
        templateKey = `${makeVariantTemplateKey(baseKey, fromName)}_${Date.now()
          .toString(36)
          .slice(-4)}`.slice(0, 60);
      }
    }

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

    const displayName =
      name.trim() && name.trim() !== rawKey
        ? name.trim()
        : `${fromName} — ${baseKey}`;

    const { rows } = await pool.query<DbRow>(
      `INSERT INTO email_templates (
        scope_type, scope_id, campaign_id, template_key, base_template_key,
        name, subject, body,
        default_sender_user_id, default_from_name, is_active,
        created_by_user_id, updated_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $11)
      RETURNING *`,
      [
        input.scopeType,
        input.scopeId,
        campaignId,
        templateKey,
        baseKey,
        displayName.slice(0, 255),
        subject.slice(0, 500),
        body,
        senderId,
        fromName,
        input.userId,
      ],
    );
    return { ...mapRow(rows[0]), canEdit: true };
  }

  // No From name: classic single override for this exact template_key.
  const templateKey = rawKey;
  const baseKey = catalogBase;

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
      scope_type, scope_id, campaign_id, template_key, base_template_key,
      name, subject, body,
      default_sender_user_id, default_from_name, is_active,
      created_by_user_id, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, TRUE, $10, $10)
    RETURNING *`,
    [
      input.scopeType,
      input.scopeId,
      campaignId,
      templateKey,
      baseKey,
      name.slice(0, 255),
      subject.slice(0, 500),
      body,
      senderId,
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
