"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const mailer_1 = require("../lib/mailer");
const pool_1 = require("../db/pool");
exports.supportRouter = (0, express_1.Router)();
const SUPPORT_INBOX_FALLBACK = "screenflow04@gmail.com";
async function resolveSupportInbox() {
    const { rows } = await pool_1.pool.query(`SELECT email
     FROM users
     WHERE is_platform_admin = TRUE
       AND email IS NOT NULL
       AND TRIM(email) <> ''
     ORDER BY id ASC
     LIMIT 1`);
    const email = typeof rows[0]?.email === "string" ? rows[0].email.trim() : "";
    return email.includes("@") ? email : SUPPORT_INBOX_FALLBACK;
}
exports.supportRouter.post("/contact", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in to contact the Success Team." });
            return;
        }
        const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
        if (!message || message.length > 4000) {
            res.status(400).json({ error: "Write a message (up to 4,000 characters)." });
            return;
        }
        const campaignSlug = typeof req.body?.campaignSlug === "string" ? req.body.campaignSlug.trim() : "";
        const campaignNameRaw = typeof req.body?.campaignName === "string" ? req.body.campaignName.trim() : "";
        let campaignId = null;
        let campaignName = campaignNameRaw;
        if (campaignSlug) {
            const { rows } = await pool_1.pool.query(`SELECT id, campaign_name FROM campaigns WHERE slug = $1 LIMIT 1`, [campaignSlug]);
            if (rows[0]) {
                campaignId = Number(rows[0].id);
                if (!campaignName)
                    campaignName = String(rows[0].campaign_name ?? "");
            }
        }
        const to = await resolveSupportInbox();
        const subject = campaignName
            ? `Success Team help: ${campaignName}`
            : "Success Team help request";
        const body = [
            `From: ${user.fullName || "Organizer"} <${user.email}>`,
            campaignName ? `Campaign: ${campaignName}` : null,
            campaignSlug ? `Slug: ${campaignSlug}` : null,
            "",
            message,
        ]
            .filter((line) => line !== null)
            .join("\n");
        const result = await (0, mailer_1.sendEmail)({
            to,
            name: "ForkUp Success Team",
            subject,
            body,
            emailType: "support_contact",
            campaignId,
            stakeholderRole: "admin",
            senderParty: "platform",
            platformSender: true,
            replyTo: user.email,
            fromName: user.fullName || "ForkUp organizer",
        });
        if (result.status !== "sent") {
            res.status(502).json({
                error: result.errorMessage?.trim() ||
                    "Email was not sent. Confirm SMTP in Super Admin → Settings → SMTP.",
            });
            return;
        }
        res.json({ success: true });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Unable to send your message." });
    }
});
//# sourceMappingURL=support.js.map