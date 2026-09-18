/**
 * Editable email template library API.
 *
 * Routes (mounted at /api/email-templates):
 * - GET    /                 list catalog (system + DB) for scope
 * - GET    /:id              get saved template row
 * - POST   /                 upsert (org/campaign/fundraiser)
 * - DELETE /:id              soft-deactivate (revert to system)
 * - POST   /preview          apply placeholders (compose preview)
 * - POST   /send             compose/send with sender + template content
 *
 * Auth: org member (write: not viewer) or fundraiser self-scope.
 * SMTP From address unchanged; senderUserId sets Reply-To (person email).
 * Optional fromName / defaultFromName overrides From display name only.
 */
import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { sendEmail } from "../lib/mailer";
import {
  applyTemplatePlaceholders,
  assertEmailTemplateAccess,
  deactivateEmailTemplate,
  getEmailTemplateById,
  listEmailTemplates,
  parsePositiveInt,
  parseScopeType,
  resolveEmailTemplate,
  upsertEmailTemplate,
  EMAIL_TEMPLATE_SAMPLE_CONTEXT,
  businessContextToPlaceholders,
  type EmailTemplateScopeType,
  type TemplatePlaceholderContext,
} from "../lib/email-templates";
import {
  parseSenderUserId,
  resolveOrgMemberSender,
  resolveUserSender,
} from "../lib/invite-sender";
import { pool } from "../db/pool";

export const emailTemplatesRouter = Router();

function parseScopeFromQuery(req: {
  query: Record<string, unknown>;
}): { scopeType: EmailTemplateScopeType; scopeId: number; campaignId: number | null } | { error: string } {
  const scopeType = parseScopeType(req.query.scopeType);
  const scopeId = parsePositiveInt(req.query.scopeId);
  if (!scopeType || !scopeId) {
    return { error: "scopeType and scopeId are required" };
  }
  const campaignId = parsePositiveInt(req.query.campaignId);
  return { scopeType, scopeId, campaignId };
}

emailTemplatesRouter.get("/", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = parseScopeFromQuery(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const writeDenied = assertEmailTemplateAccess(
      user,
      parsed.scopeType,
      parsed.scopeId,
      "write",
    );
    const readDenied = assertEmailTemplateAccess(
      user,
      parsed.scopeType,
      parsed.scopeId,
      "read",
    );
    if (readDenied) {
      res.status(403).json({ error: readDenied });
      return;
    }

    const templates = await listEmailTemplates({
      scopeType: parsed.scopeType,
      scopeId: parsed.scopeId,
      campaignId: parsed.campaignId,
      canEdit: !writeDenied,
    });
    res.json({
      scopeType: parsed.scopeType,
      scopeId: parsed.scopeId,
      campaignId: parsed.campaignId,
      templates,
      placeholders: Object.keys(businessContextToPlaceholders(EMAIL_TEMPLATE_SAMPLE_CONTEXT)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list email templates" });
  }
});

emailTemplatesRouter.post("/preview", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const body = req.body as {
      scopeType?: string;
      scopeId?: number;
      campaignId?: number | null;
      templateKey?: string;
      subject?: string;
      body?: string;
      placeholders?: TemplatePlaceholderContext;
    };
    const scopeType = parseScopeType(body.scopeType);
    const scopeId = parsePositiveInt(body.scopeId);
    if (!scopeType || !scopeId) {
      res.status(400).json({ error: "scopeType and scopeId are required" });
      return;
    }
    const denied = assertEmailTemplateAccess(user, scopeType, scopeId, "read");
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }

    let subject = typeof body.subject === "string" ? body.subject : "";
    let text = typeof body.body === "string" ? body.body : "";
    const templateKey =
      typeof body.templateKey === "string" ? body.templateKey.trim() : "";

    if ((!subject || !text) && templateKey) {
      const resolved = await resolveEmailTemplate({
        scopeType,
        scopeId,
        templateKey,
        campaignId: parsePositiveInt(body.campaignId),
      });
      if (!resolved) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      if (!subject) subject = resolved.subject;
      if (!text) text = resolved.body;
    }

    const placeholders: TemplatePlaceholderContext = {
      ...businessContextToPlaceholders(EMAIL_TEMPLATE_SAMPLE_CONTEXT),
      ...(body.placeholders ?? {}),
      fundraiserName: user.fullName || user.email,
    };

    res.json({
      subject: applyTemplatePlaceholders(subject, placeholders),
      body: applyTemplatePlaceholders(text, placeholders),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to preview email template" });
  }
});

/**
 * Compose + send: pick template (or raw subject/body), From sender, recipient.
 */
emailTemplatesRouter.post("/send", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const body = req.body as {
      scopeType?: string;
      scopeId?: number;
      campaignId?: number | null;
      templateKey?: string;
      to?: string;
      toName?: string;
      subject?: string;
      body?: string;
      senderUserId?: number;
      /** Custom From display name only (not email). */
      fromName?: string | null;
      placeholders?: TemplatePlaceholderContext;
      emailType?: string;
      saveAsTemplate?: boolean;
      name?: string;
    };

    const scopeType = parseScopeType(body.scopeType);
    const scopeId = parsePositiveInt(body.scopeId);
    if (!scopeType || !scopeId) {
      res.status(400).json({ error: "scopeType and scopeId are required" });
      return;
    }
    const denied = assertEmailTemplateAccess(user, scopeType, scopeId, "write");
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }

    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!to.includes("@")) {
      res.status(400).json({ error: "A valid recipient email (to) is required" });
      return;
    }

    const templateKey =
      typeof body.templateKey === "string" ? body.templateKey.trim() : "custom";
    const campaignId = parsePositiveInt(body.campaignId);

    let subject = typeof body.subject === "string" ? body.subject : "";
    let text = typeof body.body === "string" ? body.body : "";
    let defaultSenderFromTemplate: number | null = null;
    let defaultFromNameFromTemplate: string | null = null;

    // Always resolve template metadata (From name / sender), even when subject/body
    // are provided by the client — otherwise saved defaultFromName is ignored on send.
    if (templateKey) {
      const resolved = await resolveEmailTemplate({
        scopeType,
        scopeId,
        templateKey,
        campaignId,
      });
      if (resolved) {
        if (!subject.trim()) subject = resolved.subject;
        if (!text.trim()) text = resolved.body;
        defaultSenderFromTemplate = resolved.defaultSenderUserId;
        defaultFromNameFromTemplate = resolved.defaultFromName;
      } else if (!subject.trim() || !text.trim()) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
    }

    if (!subject.trim() || !text.trim()) {
      res.status(400).json({ error: "subject and body are required" });
      return;
    }

    const customFromName =
      typeof body.fromName === "string" && body.fromName.trim()
        ? body.fromName.trim().slice(0, 255)
        : null;

    if (body.saveAsTemplate) {
      await upsertEmailTemplate({
        scopeType,
        scopeId,
        campaignId,
        templateKey: templateKey || "custom",
        name: typeof body.name === "string" ? body.name : templateKey || "Custom",
        subject,
        body: text,
        defaultSenderUserId:
          parseSenderUserId(body.senderUserId) ?? defaultSenderFromTemplate,
        defaultFromName: customFromName ?? defaultFromNameFromTemplate,
        userId: user.id,
      });
    }

    const placeholders: TemplatePlaceholderContext = {
      ...businessContextToPlaceholders(EMAIL_TEMPLATE_SAMPLE_CONTEXT),
      ...(body.placeholders ?? {}),
      fundraiserName: user.fullName || user.email,
    };
    const finalSubject = applyTemplatePlaceholders(subject, placeholders);
    const finalBody = applyTemplatePlaceholders(text, placeholders);

    const senderId =
      parseSenderUserId(body.senderUserId) ?? defaultSenderFromTemplate;
    let personFromName: string | null = null;
    let replyTo: string | null = null;
    if (senderId != null) {
      if (scopeType === "fundraiser_user") {
        const headers = await resolveUserSender(senderId);
        if (!headers || headers.userId !== user.id) {
          res.status(400).json({ error: "senderUserId must be the signed-in fundraiser" });
          return;
        }
        personFromName = headers.fromName;
        replyTo = headers.replyTo;
      } else {
        const orgType = scopeType === "nonprofit" ? "nonprofit" : "business";
        const headers = await resolveOrgMemberSender(orgType, scopeId, senderId);
        if (!headers) {
          res.status(400).json({
            error: "senderUserId must be a member of this organization",
          });
          return;
        }
        personFromName = headers.fromName;
        replyTo = headers.replyTo;
      }
    }

    // From display name: request override → template default → selected person.
    const fromName =
      customFromName ?? defaultFromNameFromTemplate ?? personFromName;

    const emailType =
      (typeof body.emailType === "string" && body.emailType.trim()) ||
      `template_${templateKey || "custom"}`;

    const result = await sendEmail({
      to,
      name: typeof body.toName === "string" ? body.toName : null,
      subject: finalSubject,
      body: finalBody,
      emailType,
      campaignId,
      stakeholderRole:
        scopeType === "business"
          ? "nonprofit"
          : scopeType === "nonprofit"
            ? "business"
            : "nonprofit",
      senderParty:
        scopeType === "business"
          ? "business"
          : scopeType === "nonprofit"
            ? "nonprofit"
            : "platform",
      platformSender: scopeType === "fundraiser_user",
      businessId: scopeType === "business" ? scopeId : null,
      ...(fromName ? { fromName } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    res.json({
      success: result.status === "sent",
      status: result.status,
      provider: result.provider,
      messageId: result.messageId,
      errorMessage: result.errorMessage ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send email from template" });
  }
});

emailTemplatesRouter.post("/", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const body = req.body as {
      scopeType?: string;
      scopeId?: number;
      campaignId?: number | null;
      templateKey?: string;
      name?: string;
      subject?: string;
      body?: string;
      defaultSenderUserId?: number | null;
      /** Custom From display name only (not email). */
      defaultFromName?: string | null;
    };
    const scopeType = parseScopeType(body.scopeType);
    const scopeId = parsePositiveInt(body.scopeId);
    if (!scopeType || !scopeId) {
      res.status(400).json({ error: "scopeType and scopeId are required" });
      return;
    }
    const denied = assertEmailTemplateAccess(user, scopeType, scopeId, "write");
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const templateKey =
      typeof body.templateKey === "string" ? body.templateKey.trim() : "";
    if (!templateKey) {
      res.status(400).json({ error: "templateKey is required" });
      return;
    }
    const campaignId = parsePositiveInt(body.campaignId);

    if (campaignId != null && scopeType === "nonprofit") {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT id FROM campaigns WHERE id = $1 AND nonprofit_id = $2 LIMIT 1`,
        [campaignId, scopeId],
      );
      if (!rows[0]) {
        res.status(400).json({ error: "campaignId does not belong to this nonprofit" });
        return;
      }
    }

    const defaultFromName =
      typeof body.defaultFromName === "string" && body.defaultFromName.trim()
        ? body.defaultFromName.trim().slice(0, 255)
        : null;

    const template = await upsertEmailTemplate({
      scopeType,
      scopeId,
      campaignId,
      templateKey,
      name: typeof body.name === "string" ? body.name : templateKey,
      subject: typeof body.subject === "string" ? body.subject : "",
      body: typeof body.body === "string" ? body.body : "",
      defaultSenderUserId: parsePositiveInt(body.defaultSenderUserId),
      defaultFromName,
      userId: user.id,
    });
    res.status(201).json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save template";
    if (/required/i.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Failed to save email template" });
  }
});

emailTemplatesRouter.get("/:id", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }
    const row = await getEmailTemplateById(id);
    if (!row || !row.isActive) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const denied = assertEmailTemplateAccess(
      user,
      row.scopeType,
      row.scopeId,
      "read",
    );
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const writeDenied = assertEmailTemplateAccess(
      user,
      row.scopeType,
      row.scopeId,
      "write",
    );
    res.json({ template: { ...row, canEdit: !writeDenied } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load email template" });
  }
});

emailTemplatesRouter.delete("/:id", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }
    const row = await getEmailTemplateById(id);
    if (!row || !row.isActive) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const denied = assertEmailTemplateAccess(
      user,
      row.scopeType,
      row.scopeId,
      "write",
    );
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    await deactivateEmailTemplate(id, user.id);
    res.json({ success: true, revertedToSystem: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete email template" });
  }
});
