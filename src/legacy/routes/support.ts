/**
 * Organizer → Success Team contact email.
 *
 * Purpose: Send a support message via Super Admin SMTP (no mailto / clipboard).
 * Route: POST /api/support/contact  (auth required)
 * Body: { message, campaignSlug?, campaignName? }
 */
import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { sendEmail } from "../lib/mailer";
import { pool } from "../db/pool";

export const supportRouter = Router();

/** Fallback when no platform-admin user email is on file. */
const SUPPORT_INBOX_FALLBACK = "screenflow04@gmail.com";

async function resolveSupportInbox(): Promise<string> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT email
     FROM users
     WHERE is_platform_admin = TRUE
       AND email IS NOT NULL
       AND TRIM(email) <> ''
     ORDER BY id ASC
     LIMIT 1`,
  );
  const email = typeof rows[0]?.email === "string" ? rows[0].email.trim() : "";
  return email.includes("@") ? email : SUPPORT_INBOX_FALLBACK;
}

supportRouter.post("/contact", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in to contact the Success Team." });
      return;
    }

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > 4000) {
      res.status(400).json({ error: "Write a message (up to 4,000 characters)." });
      return;
    }

    const campaignSlug =
      typeof req.body?.campaignSlug === "string" ? req.body.campaignSlug.trim() : "";
    const campaignNameRaw =
      typeof req.body?.campaignName === "string" ? req.body.campaignName.trim() : "";

    let campaignId: number | null = null;
    let campaignName = campaignNameRaw;
    if (campaignSlug) {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT id, campaign_name FROM campaigns WHERE slug = $1 LIMIT 1`,
        [campaignSlug],
      );
      if (rows[0]) {
        campaignId = Number(rows[0].id);
        if (!campaignName) campaignName = String(rows[0].campaign_name ?? "");
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

    const result = await sendEmail({
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
        error:
          result.errorMessage?.trim() ||
          "Email was not sent. Confirm SMTP in Super Admin → Settings → SMTP.",
      });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to send your message." });
  }
});
