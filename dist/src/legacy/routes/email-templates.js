"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailTemplatesRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const mailer_1 = require("../lib/mailer");
const email_templates_1 = require("../lib/email-templates");
const invite_sender_1 = require("../lib/invite-sender");
const pool_1 = require("../db/pool");
exports.emailTemplatesRouter = (0, express_1.Router)();
function parseScopeFromQuery(req) {
    const scopeType = (0, email_templates_1.parseScopeType)(req.query.scopeType);
    const scopeId = (0, email_templates_1.parsePositiveInt)(req.query.scopeId);
    if (!scopeType || !scopeId) {
        return { error: "scopeType and scopeId are required" };
    }
    const campaignId = (0, email_templates_1.parsePositiveInt)(req.query.campaignId);
    return { scopeType, scopeId, campaignId };
}
exports.emailTemplatesRouter.get("/", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const parsed = parseScopeFromQuery(req);
        if ("error" in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        const writeDenied = (0, email_templates_1.assertEmailTemplateAccess)(user, parsed.scopeType, parsed.scopeId, "write");
        const readDenied = (0, email_templates_1.assertEmailTemplateAccess)(user, parsed.scopeType, parsed.scopeId, "read");
        if (readDenied) {
            res.status(403).json({ error: readDenied });
            return;
        }
        const templates = await (0, email_templates_1.listEmailTemplates)({
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
            placeholders: Object.keys((0, email_templates_1.businessContextToPlaceholders)(email_templates_1.EMAIL_TEMPLATE_SAMPLE_CONTEXT)),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to list email templates" });
    }
});
exports.emailTemplatesRouter.post("/preview", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const body = req.body;
        const scopeType = (0, email_templates_1.parseScopeType)(body.scopeType);
        const scopeId = (0, email_templates_1.parsePositiveInt)(body.scopeId);
        if (!scopeType || !scopeId) {
            res.status(400).json({ error: "scopeType and scopeId are required" });
            return;
        }
        const denied = (0, email_templates_1.assertEmailTemplateAccess)(user, scopeType, scopeId, "read");
        if (denied) {
            res.status(403).json({ error: denied });
            return;
        }
        let subject = typeof body.subject === "string" ? body.subject : "";
        let text = typeof body.body === "string" ? body.body : "";
        const templateKey = typeof body.templateKey === "string" ? body.templateKey.trim() : "";
        if ((!subject || !text) && templateKey) {
            const resolved = await (0, email_templates_1.resolveEmailTemplate)({
                scopeType,
                scopeId,
                templateKey,
                campaignId: (0, email_templates_1.parsePositiveInt)(body.campaignId),
            });
            if (!resolved) {
                res.status(404).json({ error: "Template not found" });
                return;
            }
            if (!subject)
                subject = resolved.subject;
            if (!text)
                text = resolved.body;
        }
        const placeholders = {
            ...(0, email_templates_1.businessContextToPlaceholders)(email_templates_1.EMAIL_TEMPLATE_SAMPLE_CONTEXT),
            ...(body.placeholders ?? {}),
            fundraiserName: user.fullName || user.email,
        };
        res.json({
            subject: (0, email_templates_1.applyTemplatePlaceholders)(subject, placeholders),
            body: (0, email_templates_1.applyTemplatePlaceholders)(text, placeholders),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to preview email template" });
    }
});
exports.emailTemplatesRouter.post("/send", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const body = req.body;
        const scopeType = (0, email_templates_1.parseScopeType)(body.scopeType);
        const scopeId = (0, email_templates_1.parsePositiveInt)(body.scopeId);
        if (!scopeType || !scopeId) {
            res.status(400).json({ error: "scopeType and scopeId are required" });
            return;
        }
        const denied = (0, email_templates_1.assertEmailTemplateAccess)(user, scopeType, scopeId, "write");
        if (denied) {
            res.status(403).json({ error: denied });
            return;
        }
        const to = typeof body.to === "string" ? body.to.trim() : "";
        if (!to.includes("@")) {
            res.status(400).json({ error: "A valid recipient email (to) is required" });
            return;
        }
        const templateKey = typeof body.templateKey === "string" ? body.templateKey.trim() : "custom";
        const campaignId = (0, email_templates_1.parsePositiveInt)(body.campaignId);
        let subject = typeof body.subject === "string" ? body.subject : "";
        let text = typeof body.body === "string" ? body.body : "";
        let defaultSenderFromTemplate = null;
        let defaultFromNameFromTemplate = null;
        if (templateKey) {
            const resolved = await (0, email_templates_1.resolveEmailTemplate)({
                scopeType,
                scopeId,
                templateKey,
                campaignId,
            });
            if (resolved) {
                if (!subject.trim())
                    subject = resolved.subject;
                if (!text.trim())
                    text = resolved.body;
                defaultSenderFromTemplate = resolved.defaultSenderUserId;
                defaultFromNameFromTemplate = resolved.defaultFromName;
            }
            else if (!subject.trim() || !text.trim()) {
                res.status(404).json({ error: "Template not found" });
                return;
            }
        }
        if (!subject.trim() || !text.trim()) {
            res.status(400).json({ error: "subject and body are required" });
            return;
        }
        const customFromName = typeof body.fromName === "string" && body.fromName.trim()
            ? body.fromName.trim().slice(0, 255)
            : null;
        if (body.saveAsTemplate) {
            const saveBaseKey = typeof body.baseTemplateKey === "string"
                ? body.baseTemplateKey.trim().slice(0, 60)
                : null;
            await (0, email_templates_1.upsertEmailTemplate)({
                scopeType,
                scopeId,
                campaignId,
                templateKey: templateKey || "custom",
                baseTemplateKey: saveBaseKey,
                name: typeof body.name === "string" ? body.name : templateKey || "Custom",
                subject,
                body: text,
                defaultSenderUserId: (0, invite_sender_1.parseSenderUserId)(body.senderUserId) ?? defaultSenderFromTemplate,
                defaultFromName: customFromName ?? defaultFromNameFromTemplate,
                userId: user.id,
            });
        }
        const placeholders = {
            ...(0, email_templates_1.businessContextToPlaceholders)(email_templates_1.EMAIL_TEMPLATE_SAMPLE_CONTEXT),
            ...(body.placeholders ?? {}),
            fundraiserName: user.fullName || user.email,
        };
        const finalSubject = (0, email_templates_1.applyTemplatePlaceholders)(subject, placeholders);
        const finalBody = (0, email_templates_1.applyTemplatePlaceholders)(text, placeholders);
        const senderId = (0, invite_sender_1.parseSenderUserId)(body.senderUserId) ?? defaultSenderFromTemplate;
        let personFromName = null;
        let replyTo = null;
        if (senderId != null) {
            if (scopeType === "fundraiser_user") {
                const headers = await (0, invite_sender_1.resolveUserSender)(senderId);
                if (!headers || headers.userId !== user.id) {
                    res.status(400).json({ error: "senderUserId must be the signed-in fundraiser" });
                    return;
                }
                personFromName = headers.fromName;
                replyTo = headers.replyTo;
            }
            else {
                const orgType = scopeType === "nonprofit" ? "nonprofit" : "business";
                const headers = await (0, invite_sender_1.resolveOrgMemberSender)(orgType, scopeId, senderId);
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
        const fromName = customFromName ?? defaultFromNameFromTemplate ?? personFromName;
        const emailType = (typeof body.emailType === "string" && body.emailType.trim()) ||
            `template_${templateKey || "custom"}`;
        const result = await (0, mailer_1.sendEmail)({
            to,
            name: typeof body.toName === "string" ? body.toName : null,
            subject: finalSubject,
            body: finalBody,
            emailType,
            campaignId,
            stakeholderRole: scopeType === "business"
                ? "nonprofit"
                : scopeType === "nonprofit"
                    ? "business"
                    : "nonprofit",
            senderParty: scopeType === "business"
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to send email from template" });
    }
});
exports.emailTemplatesRouter.post("/", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const body = req.body;
        const scopeType = (0, email_templates_1.parseScopeType)(body.scopeType);
        const scopeId = (0, email_templates_1.parsePositiveInt)(body.scopeId);
        if (!scopeType || !scopeId) {
            res.status(400).json({ error: "scopeType and scopeId are required" });
            return;
        }
        const denied = (0, email_templates_1.assertEmailTemplateAccess)(user, scopeType, scopeId, "write");
        if (denied) {
            res.status(403).json({ error: denied });
            return;
        }
        const templateKey = typeof body.templateKey === "string" ? body.templateKey.trim() : "";
        if (!templateKey) {
            res.status(400).json({ error: "templateKey is required" });
            return;
        }
        const campaignId = (0, email_templates_1.parsePositiveInt)(body.campaignId);
        if (campaignId != null && scopeType === "nonprofit") {
            const { rows } = await pool_1.pool.query(`SELECT id FROM campaigns WHERE id = $1 AND nonprofit_id = $2 LIMIT 1`, [campaignId, scopeId]);
            if (!rows[0]) {
                res.status(400).json({ error: "campaignId does not belong to this nonprofit" });
                return;
            }
        }
        const defaultFromName = typeof body.defaultFromName === "string" && body.defaultFromName.trim()
            ? body.defaultFromName.trim().slice(0, 255)
            : null;
        const baseTemplateKey = typeof body.baseTemplateKey === "string" && body.baseTemplateKey.trim()
            ? body.baseTemplateKey.trim().slice(0, 60)
            : null;
        const template = await (0, email_templates_1.upsertEmailTemplate)({
            scopeType,
            scopeId,
            campaignId,
            templateKey,
            baseTemplateKey,
            name: typeof body.name === "string" ? body.name : templateKey,
            subject: typeof body.subject === "string" ? body.subject : "",
            body: typeof body.body === "string" ? body.body : "",
            defaultSenderUserId: (0, email_templates_1.parsePositiveInt)(body.defaultSenderUserId),
            defaultFromName,
            userId: user.id,
        });
        res.status(201).json({ template });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save template";
        if (/required/i.test(message)) {
            res.status(400).json({ error: message });
            return;
        }
        console.error(err);
        res.status(500).json({ error: "Failed to save email template" });
    }
});
exports.emailTemplatesRouter.get("/:id", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const id = (0, email_templates_1.parsePositiveInt)(req.params.id);
        if (!id) {
            res.status(400).json({ error: "Invalid template id" });
            return;
        }
        const row = await (0, email_templates_1.getEmailTemplateById)(id);
        if (!row || !row.isActive) {
            res.status(404).json({ error: "Template not found" });
            return;
        }
        const denied = (0, email_templates_1.assertEmailTemplateAccess)(user, row.scopeType, row.scopeId, "read");
        if (denied) {
            res.status(403).json({ error: denied });
            return;
        }
        const writeDenied = (0, email_templates_1.assertEmailTemplateAccess)(user, row.scopeType, row.scopeId, "write");
        res.json({ template: { ...row, canEdit: !writeDenied } });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load email template" });
    }
});
exports.emailTemplatesRouter.delete("/:id", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const id = (0, email_templates_1.parsePositiveInt)(req.params.id);
        if (!id) {
            res.status(400).json({ error: "Invalid template id" });
            return;
        }
        const row = await (0, email_templates_1.getEmailTemplateById)(id);
        if (!row || !row.isActive) {
            res.status(404).json({ error: "Template not found" });
            return;
        }
        const denied = (0, email_templates_1.assertEmailTemplateAccess)(user, row.scopeType, row.scopeId, "write");
        if (denied) {
            res.status(403).json({ error: denied });
            return;
        }
        await (0, email_templates_1.deactivateEmailTemplate)(id, user.id);
        res.json({ success: true, revertedToSystem: true });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete email template" });
    }
});
//# sourceMappingURL=email-templates.js.map