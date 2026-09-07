/**
 * Super Admin API
 *
 * POST   /api/superadmin/login
 *   body: { username, password }
 *   response: { token, user }
 *
 * POST   /api/superadmin/forgot-password
 *   body: { emailOrUsername }
 *   response: { success, message }
 *
 * POST   /api/superadmin/reset-password
 *   body: { token, password }
 *   response: { success }
 *
 * GET    /api/superadmin/me
 * PATCH  /api/superadmin/profile
 * POST   /api/superadmin/change-password
 *
 * GET/PUT /api/superadmin/settings/ai
 *   GET response: {
 *     selectedModelId,
 *     selectedReceiptModelId,
 *     pricingSource: "aws" | "fallback" | "mixed",
 *     pricingFetchedAt: ISO string,
 *     models: [{ id, label, vendor, tier, blurb, inputPer1M, outputPer1M,
 *                pricingSource, estimatedRunCost }]
 *   }
 * GET/PUT /api/superadmin/settings/charges
 * GET/PUT /api/superadmin/settings/smtp
 * POST    /api/superadmin/settings/smtp/test
 *
 * GET     /api/superadmin/access-requests
 * POST    /api/superadmin/access-requests/:id/approve
 * POST    /api/superadmin/access-requests/:id/deny
 *
 * GET     /api/superadmin/forkup-review-queue
 * GET     /api/superadmin/forkup-review/:slug
 * POST    /api/superadmin/forkup-review/:slug/approve
 * POST    /api/superadmin/forkup-review/:slug/deny
 * POST    /api/superadmin/forkup-review/:slug/request-changes
 *
 * GET     /api/superadmin/organizations/:type/:id
 *   query: requestId?
 *   response: {
 *     organizationType, organization, locations?, accessRequest,
 *     activitySummary, campaigns[]  // creator-parity KPIs (raised, supporters, etc.)
 *   }
 *
 * GET     /api/superadmin/live-campaigns
 *   response: [{ slug, name, nonprofit, status, goal, raised, startDate, endDate, updatedAt }]
 *
 * DELETE  /api/superadmin/live-campaigns/:slug
 *   response: { success, slug }
 *   Hard-deletes only when campaign_status = 'live' (child rows cascade).
 *
 * Directory (v1 admin parity — list/view; append-only):
 * GET     /api/superadmin/overview
 * GET     /api/superadmin/users?search&limit&offset
 * GET     /api/superadmin/roles
 * GET     /api/superadmin/nonprofits?search&limit&offset
 * GET     /api/superadmin/businesses?search&limit&offset
 * GET     /api/superadmin/campaigns?search&status&limit&offset
 * GET     /api/superadmin/fundraisers?search&limit&offset
 * GET     /api/superadmin/donations?limit&offset
 */
import { Router } from "express";
import crypto from "crypto";
import type { QueryResultRow } from "pg";
import nodemailer from "nodemailer";
import {
  generateSessionToken,
  hashPassword,
  sessionExpiry,
  verifyPassword,
  type AuthUser,
} from "../lib/auth";
import { pool } from "../db/pool";
import { requirePlatformAdmin } from "../lib/require-platform-admin";
import {
  getPlatformSettings,
  setPlatformSettings,
} from "../lib/platform-settings";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import { getBedrockLivePricing } from "../lib/bedrock-pricing";
import { BEDROCK_MODEL_CATALOG, isAllowedBedrockModel } from "../lib/bedrock-model-catalog";
import { toDateOnlyString } from "../lib/date-only";
import { promoteCampaignAfterForkupApproval } from "../lib/campaign-go-live-from-review";

export const superadminRouter = Router();

const AI_MODELS = BEDROCK_MODEL_CATALOG;

/** Typical receipt vision OCR: ~2k input tokens, ~500 output tokens. */
const RECEIPT_OCR_INPUT_TOKENS = 2_000;
const RECEIPT_OCR_OUTPUT_TOKENS = 500;

function mapAiModelsWithPricing(
  pricing: Awaited<ReturnType<typeof getBedrockLivePricing>>,
) {
  const rateById = new Map(pricing.rates.map((r) => [r.modelId, r]));
  return AI_MODELS.map((m) => {
    const rate = rateById.get(m.id);
    const inputPer1M = rate?.inputPer1M ?? m.inputPer1M;
    const outputPer1M = rate?.outputPer1M ?? m.outputPer1M;
    return {
      ...m,
      inputPer1M,
      outputPer1M,
      pricingSource: rate?.source ?? "fallback",
      estimatedRunCost:
        (inputPer1M * 10_000 + outputPer1M * 3_500) / 1_000_000,
      estimatedReceiptRunCost:
        (inputPer1M * RECEIPT_OCR_INPUT_TOKENS + outputPer1M * RECEIPT_OCR_OUTPUT_TOKENS) /
        1_000_000,
    };
  });
}

function adminUserJson(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    username: user.username,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

async function createSession(userId: number): Promise<string> {
  const token = generateSessionToken();
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, sessionExpiry()],
  );
  return token;
}

// ── Public auth ──────────────────────────────────────────────────────────────

superadminRouter.post("/login", async (req, res) => {
  try {
    const usernameRaw =
      typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!usernameRaw || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const key = usernameRaw.toLowerCase();
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, email, full_name, username, password_hash,
              COALESCE(is_platform_admin, FALSE) AS is_platform_admin
       FROM users
       WHERE LOWER(COALESCE(username, '')) = $1
          OR LOWER(email) = $1
       LIMIT 1`,
      [key],
    );
    if (rows.length === 0 || !rows[0].password_hash) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    if (!rows[0].is_platform_admin) {
      res.status(403).json({ error: "Not a platform superadmin account" });
      return;
    }
    const ok = await verifyPassword(password, String(rows[0].password_hash));
    if (!ok) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const token = await createSession(Number(rows[0].id));
    res.json({
      token,
      user: {
        id: Number(rows[0].id),
        email: rows[0].email,
        fullName: rows[0].full_name,
        username: rows[0].username,
        isPlatformAdmin: true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

superadminRouter.post("/forgot-password", async (req, res) => {
  try {
    const value =
      typeof req.body?.emailOrUsername === "string"
        ? req.body.emailOrUsername.trim().toLowerCase()
        : "";
    // Always return a generic success message (do not leak account existence).
    const generic = {
      success: true,
      message:
        "If an account matches, a password reset link has been sent to the registered email.",
    };
    if (!value) {
      res.json(generic);
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, email, full_name
       FROM users
       WHERE is_platform_admin = TRUE
         AND (LOWER(email) = $1 OR LOWER(COALESCE(username, '')) = $1)
       LIMIT 1`,
      [value],
    );
    if (rows.length === 0) {
      res.json(generic);
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [rows[0].id, token, expires],
    );

    const base = resolveFrontendBaseUrl();
    const resetUrl = `${base}/?step=super-admin-reset-password&token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: String(rows[0].email),
      name: rows[0].full_name,
      subject: "ForkUp Super Admin password reset",
      body:
        `Reset your ForkUp Super Admin password using this link (valid 1 hour):\n\n${resetUrl}\n\n` +
        `If you did not request this, you can ignore this email.`,
      emailType: "superadmin_password_reset",
      stakeholderRole: "admin",
      relatedToken: token,
    });

    res.json(generic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to process forgot-password request" });
  }
});

superadminRouter.post("/reset-password", async (req, res) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token || password.length < 8) {
      res.status(400).json({ error: "Valid token and password (8+ chars) are required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token = $1
       LIMIT 1`,
      [token],
    );
    if (rows.length === 0) {
      res.status(400).json({ error: "Invalid or expired reset token" });
      return;
    }
    if (rows[0].used_at || new Date(rows[0].expires_at) < new Date()) {
      res.status(400).json({ error: "Invalid or expired reset token" });
      return;
    }

    const passwordHash = await hashPassword(password);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
      passwordHash,
      rows[0].user_id,
    ]);
    await pool.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [
      rows[0].id,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ── Authenticated routes ─────────────────────────────────────────────────────

superadminRouter.use(requirePlatformAdmin);

superadminRouter.get("/me", async (req, res) => {
  const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
  res.json({ user: adminUserJson(user) });
});

superadminRouter.patch("/profile", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const fullName =
      typeof req.body?.fullName === "string" ? req.body.fullName.trim() : user.fullName;
    const emailRaw =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : user.email;

    if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw)) {
      res.status(400).json({ error: "Enter a valid email address" });
      return;
    }

    const { rows: clash } = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`,
      [emailRaw, user.id],
    );
    if (clash.length > 0) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }

    await pool.query(
      `UPDATE users SET full_name = $1, email = $2, updated_at = NOW() WHERE id = $3`,
      [fullName || null, emailRaw, user.id],
    );

    res.json({
      user: {
        ...adminUserJson(user),
        fullName: fullName || null,
        email: emailRaw,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

superadminRouter.post("/change-password", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const currentPassword =
      typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (!currentPassword || newPassword.length < 8) {
      res.status(400).json({ error: "Current password and new password (8+ chars) required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [user.id],
    );
    if (!rows[0]?.password_hash) {
      res.status(400).json({ error: "Account has no password set" });
      return;
    }
    const ok = await verifyPassword(currentPassword, String(rows[0].password_hash));
    if (!ok) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
      passwordHash,
      user.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

superadminRouter.get("/settings/ai", async (_req, res) => {
  try {
    const settings = await getPlatformSettings(["ai_model_id", "receipt_ai_model_id"]);
    const selected =
      settings.ai_model_id || process.env.BEDROCK_MODEL_ID?.trim() || "amazon.nova-lite-v1:0";
    const selectedReceipt =
      settings.receipt_ai_model_id ||
      process.env.BEDROCK_RECEIPT_MODEL_ID?.trim() ||
      "amazon.nova-lite-v1:0";
    // Live AWS Price List rates when credentials allow; else hardcoded fallbacks.
    const pricing = await getBedrockLivePricing(AI_MODELS);
    res.json({
      selectedModelId: selected,
      selectedReceiptModelId: selectedReceipt,
      pricingSource: pricing.pricingSource,
      pricingFetchedAt: pricing.pricingFetchedAt,
      models: mapAiModelsWithPricing(pricing),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load AI settings" });
  }
});

superadminRouter.put("/settings/ai", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
    const receiptModelId =
      typeof req.body?.receiptModelId === "string" ? req.body.receiptModelId.trim() : "";
    const updates: Record<string, string> = {};
    if (modelId) {
      if (!isAllowedBedrockModel(modelId)) {
        res.status(400).json({ error: "Unknown AI model" });
        return;
      }
      updates.ai_model_id = modelId;
    }
    if (receiptModelId) {
      if (!isAllowedBedrockModel(receiptModelId)) {
        res.status(400).json({ error: "Unknown receipt AI model" });
        return;
      }
      updates.receipt_ai_model_id = receiptModelId;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "modelId or receiptModelId is required" });
      return;
    }
    await setPlatformSettings(updates, user.id);
    const settings = await getPlatformSettings(["ai_model_id", "receipt_ai_model_id"]);
    res.json({
      success: true,
      selectedModelId:
        settings.ai_model_id || process.env.BEDROCK_MODEL_ID?.trim() || "amazon.nova-lite-v1:0",
      selectedReceiptModelId:
        settings.receipt_ai_model_id ||
        process.env.BEDROCK_RECEIPT_MODEL_ID?.trim() ||
        "amazon.nova-lite-v1:0",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save AI settings" });
  }
});

superadminRouter.get("/settings/charges", async (_req, res) => {
  try {
    const settings = await getPlatformSettings(["platform_fee_percent"]);
    const fee = Number(settings.platform_fee_percent ?? "15");
    const platformFeePercent = Number.isFinite(fee) ? fee : 15;
    const exampleSales = 2000;
    const exampleGiveback = 15;
    const donationPool = Math.round(exampleSales * (exampleGiveback / 100) * 100) / 100;
    const platformFee = Math.round(donationPool * (platformFeePercent / 100) * 100) / 100;
    res.json({
      platformFeePercent,
      example: {
        eligibleSales: exampleSales,
        givebackPercentage: exampleGiveback,
        donationPool,
        platformFee,
        netNonprofitAmount: Math.round((donationPool - platformFee) * 100) / 100,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load charges settings" });
  }
});

superadminRouter.put("/settings/charges", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const fee = Number(req.body?.platformFeePercent);
    if (!Number.isFinite(fee) || fee < 0 || fee > 100) {
      res.status(400).json({ error: "platformFeePercent must be 0–100" });
      return;
    }
    await setPlatformSettings({ platform_fee_percent: String(fee) }, user.id);
    res.json({ success: true, platformFeePercent: fee });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save charges settings" });
  }
});

superadminRouter.get("/settings/smtp", async (_req, res) => {
  try {
    const s = await getPlatformSettings([
      "email_provider",
      "smtp_host",
      "smtp_port",
      "smtp_user",
      "smtp_pass",
      "smtp_from",
      "smtp_secure",
    ]);
    const rawProvider = (s.email_provider || "smtp").trim().toLowerCase();
    res.json({
      // SES is hidden — expose only smtp | noop to the Super Admin UI.
      emailProvider: rawProvider === "noop" ? "noop" : "smtp",
      smtpHost: s.smtp_host || "",
      smtpPort: Number(s.smtp_port || "587"),
      smtpUser: s.smtp_user || "",
      smtpPassSet: Boolean(s.smtp_pass),
      smtpPassMasked: maskSecret(s.smtp_pass),
      smtpFrom: s.smtp_from || "",
      smtpSecure: s.smtp_secure === "true",
      sesConfigured: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load SMTP settings" });
  }
});

superadminRouter.put("/settings/smtp", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const body = req.body ?? {};
    // SES is hidden — only smtp | noop are accepted; legacy "ses" coerces to smtp.
    const emailProvider =
      body.emailProvider === "noop"
        ? "noop"
        : body.emailProvider === "smtp" || body.emailProvider === "ses"
          ? "smtp"
          : "smtp";

    const updates: Record<string, string> = {
      email_provider: emailProvider,
      smtp_host: typeof body.smtpHost === "string" ? body.smtpHost.trim() : "",
      smtp_port: String(Number(body.smtpPort) || 587),
      smtp_user: typeof body.smtpUser === "string" ? body.smtpUser.trim() : "",
      smtp_from: typeof body.smtpFrom === "string" ? body.smtpFrom.trim() : "",
      smtp_secure: body.smtpSecure === true || body.smtpSecure === "true" ? "true" : "false",
    };

    if (typeof body.smtpPass === "string" && body.smtpPass.trim() && body.smtpPass !== "••••") {
      updates.smtp_pass = body.smtpPass;
    }

    await setPlatformSettings(updates, user.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save SMTP settings" });
  }
});

superadminRouter.post("/settings/smtp/test", async (req, res) => {
  try {
    const to =
      typeof req.body?.to === "string" && req.body.to.trim()
        ? req.body.to.trim()
        : (req as typeof req & { platformAdmin: AuthUser }).platformAdmin.email;

    const result = await sendEmail({
      to,
      subject: "ForkUp SMTP test",
      body: "This is a test email from the ForkUp Super Admin SMTP settings panel.",
      emailType: "superadmin_smtp_test",
      stakeholderRole: "admin",
    });

    res.json({ success: result.status === "sent", result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "SMTP test failed" });
  }
});

/**
 * Nick V2 Layer 6 — campaigns needing ForkUp timing review.
 * Method: GET /api/superadmin/forkup-review-queue
 * Response: [{ slug, name, nonprofit, businessTimingStatus, forkupReviewStatus, startDate, eventDate }]
 */
superadminRouter.get("/forkup-review-queue", async (_req, res) => {
  try {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT c.slug, c.campaign_name, c.business_timing_status, c.forkup_review_status,
              c.campaign_start_date, c.event_date, c.campaign_status,
              n.organization_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE (c.business_timing_status = 'needs_forkup_review'
          OR c.forkup_review_status = 'pending'
          OR c.campaign_status = 'in_review')
         AND c.forkup_review_status NOT IN ('approved', 'denied', 'changes_requested')
       ORDER BY c.updated_at DESC
       LIMIT 100`,
    );
    res.json(
      rows.map((r) => ({
        slug: String(r.slug),
        name: String(r.campaign_name),
        nonprofit: String(r.organization_name),
        status: String(r.campaign_status),
        businessTimingStatus: String(r.business_timing_status ?? "ok"),
        forkupReviewStatus: String(r.forkup_review_status ?? "none"),
        startDate: r.campaign_start_date
          ? String(r.campaign_start_date).slice(0, 10)
          : null,
        eventDate: r.event_date ? String(r.event_date).slice(0, 10) : null,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load ForkUp review queue" });
  }
});

/**
 * Full campaign detail for ForkUp review "View details".
 * Method: GET /api/superadmin/forkup-review/:slug
 * Response: {
 *   slug, name, nonprofit, status, goal, story, coverImageUrl,
 *   startDate, endDate, eventDate,
 *   businessTimingStatus, forkupReviewStatus, forkupReviewReason,
 *   methods: [{ methodType, methodName, methodStatus }]
 * }
 */
superadminRouter.get("/forkup-review/:slug", async (req, res) => {
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "Campaign slug is required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT c.slug, c.campaign_name, c.campaign_status, c.campaign_goal,
              c.campaign_story, c.cover_image_url,
              c.campaign_start_date, c.campaign_end_date, c.event_date,
              c.business_timing_status, c.forkup_review_status, c.forkup_review_reason,
              n.organization_name, n.contact_email, n.contact_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE c.slug = $1
       LIMIT 1`,
      [slug],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const c = rows[0];
    const { rows: methods } = await pool.query<QueryResultRow>(
      `SELECT method_type, method_name, method_status, timing_status
       FROM campaign_methods
       WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = $1)
       ORDER BY id`,
      [slug],
    );

    res.json({
      slug: String(c.slug),
      name: String(c.campaign_name),
      nonprofit: String(c.organization_name),
      nonprofitContactName: c.contact_name ? String(c.contact_name) : null,
      nonprofitContactEmail: c.contact_email ? String(c.contact_email) : null,
      status: String(c.campaign_status),
      goal: Number(c.campaign_goal ?? 0),
      story: c.campaign_story != null ? String(c.campaign_story) : null,
      coverImageUrl: c.cover_image_url != null ? String(c.cover_image_url) : null,
      startDate: c.campaign_start_date
        ? String(c.campaign_start_date).slice(0, 10)
        : null,
      endDate: c.campaign_end_date
        ? String(c.campaign_end_date).slice(0, 10)
        : null,
      eventDate: c.event_date ? String(c.event_date).slice(0, 10) : null,
      businessTimingStatus: String(c.business_timing_status ?? "ok"),
      forkupReviewStatus: String(c.forkup_review_status ?? "none"),
      forkupReviewReason:
        c.forkup_review_reason != null ? String(c.forkup_review_reason) : null,
      methods: methods.map((m) => ({
        methodType: String(m.method_type),
        methodName: String(m.method_name),
        methodStatus: String(m.method_status),
        timingStatus: String(m.timing_status ?? "ok"),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load ForkUp review campaign details" });
  }
});

/**
 * Approve short-timeline / launch ForkUp review for a campaign.
 * Method: POST /api/superadmin/forkup-review/:slug/approve
 * Body: {}
 * Response: {
 *   success, slug, forkupReviewStatus: "approved", businessTimingStatus: "ok",
 *   campaignStatus, emailSent
 * }
 *
 * On approve: clears timing gate, sets campaign live / ready / invitation_phase,
 * emails the nonprofit, and sends deferred business invitations.
 */
superadminRouter.post("/forkup-review/:slug/approve", async (req, res) => {
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "Campaign slug is required" });
      return;
    }

    const result = await promoteCampaignAfterForkupApproval(slug);
    if (!result) {
      res.status(404).json({ error: "Campaign not found in ForkUp review queue" });
      return;
    }

    res.json({
      success: true,
      slug: result.slug,
      forkupReviewStatus: result.forkupReviewStatus,
      businessTimingStatus: result.businessTimingStatus,
      campaignStatus: result.campaignStatus,
      emailSent: result.emailSent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve ForkUp review" });
  }
});

/**
 * Deny short-timeline ForkUp review for a campaign.
 * Method: POST /api/superadmin/forkup-review/:slug/deny
 * Body: {}
 * Response: { success, slug, forkupReviewStatus: "denied" }
 */
superadminRouter.post("/forkup-review/:slug/deny", async (req, res) => {
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "Campaign slug is required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `UPDATE campaigns
       SET forkup_review_status = 'denied',
           updated_at = NOW()
       WHERE slug = $1
         AND (campaign_status = 'in_review'
           OR business_timing_status = 'needs_forkup_review'
           OR forkup_review_status = 'pending')
         AND forkup_review_status NOT IN ('approved', 'denied', 'changes_requested')
       RETURNING slug, forkup_review_status, business_timing_status`,
      [slug],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Campaign not found in ForkUp review queue" });
      return;
    }

    res.json({
      success: true,
      slug: String(rows[0].slug),
      forkupReviewStatus: String(rows[0].forkup_review_status),
      businessTimingStatus: String(rows[0].business_timing_status),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deny ForkUp review" });
  }
});

/**
 * Request changes on a campaign in the ForkUp review queue.
 * Method: POST /api/superadmin/forkup-review/:slug/request-changes
 * Body: { notes?: string }
 * Response: {
 *   success, slug, forkupReviewStatus: "changes_requested", campaignStatus: "draft"
 * }
 *
 * Sets review to changes_requested, stores notes in forkup_review_reason,
 * and returns the campaign to draft so the organizer can edit and resubmit.
 */
superadminRouter.post("/forkup-review/:slug/request-changes", async (req, res) => {
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "Campaign slug is required" });
      return;
    }

    const notesRaw =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    const notes = notesRaw.length > 0 ? notesRaw.slice(0, 4000) : null;

    const { rows } = await pool.query<QueryResultRow>(
      `UPDATE campaigns
       SET forkup_review_status = 'changes_requested',
           forkup_review_reason = COALESCE($2, forkup_review_reason),
           campaign_status = 'draft',
           updated_at = NOW()
       WHERE slug = $1
         AND (campaign_status = 'in_review'
           OR business_timing_status = 'needs_forkup_review'
           OR forkup_review_status = 'pending')
         AND forkup_review_status NOT IN ('approved', 'denied', 'changes_requested')
       RETURNING slug, forkup_review_status, business_timing_status, campaign_status`,
      [slug, notes],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Campaign not found in ForkUp review queue" });
      return;
    }

    res.json({
      success: true,
      slug: String(rows[0].slug),
      forkupReviewStatus: String(rows[0].forkup_review_status),
      businessTimingStatus: String(rows[0].business_timing_status),
      campaignStatus: String(rows[0].campaign_status),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to request changes on ForkUp review" });
  }
});

/**
 * List all live campaigns for superadmin console.
 * Method: GET /api/superadmin/live-campaigns
 * Response: [{ slug, name, nonprofit, status, goal, raised, startDate, endDate, updatedAt }]
 */
superadminRouter.get("/live-campaigns", async (_req, res) => {
  try {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT c.slug, c.campaign_name, c.campaign_status, c.campaign_goal, c.raised,
              c.campaign_start_date, c.campaign_end_date, c.updated_at,
              n.organization_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE c.campaign_status = 'live'
       ORDER BY c.updated_at DESC
       LIMIT 500`,
    );
    res.json(
      rows.map((r) => ({
        slug: String(r.slug),
        name: String(r.campaign_name),
        nonprofit: String(r.organization_name),
        status: String(r.campaign_status),
        goal: Number(r.campaign_goal ?? 0),
        raised: Number(r.raised ?? 0),
        startDate: r.campaign_start_date
          ? String(r.campaign_start_date).slice(0, 10)
          : null,
        endDate: r.campaign_end_date
          ? String(r.campaign_end_date).slice(0, 10)
          : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live campaigns" });
  }
});

/**
 * Hard-delete a live campaign (superadmin).
 * Method: DELETE /api/superadmin/live-campaigns/:slug
 * Response: { success, slug }
 * Only deletes when campaign_status = 'live'. Related rows cascade via FKs.
 */
superadminRouter.delete("/live-campaigns/:slug", async (req, res) => {
  const connection = await pool.connect();
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "Campaign slug is required" });
      return;
    }

    await connection.query("BEGIN");
    const { rows } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaigns WHERE slug = $1 AND campaign_status = 'live'`,
      [slug],
    );
    if (rows.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Live campaign not found" });
      return;
    }

    await connection.query("DELETE FROM campaigns WHERE id = $1", [rows[0].id]);
    await connection.query("COMMIT");
    res.json({ success: true, slug });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete live campaign" });
  } finally {
    connection.release();
  }
});

/** Proxy verification queue (same data as /api/manage/access-requests) behind superadmin auth. */
superadminRouter.get("/access-requests", async (req, res) => {
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "pending";
    if (status) {
      params.push(status);
      conditions.push(`ar.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(200);

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT ar.id, ar.organization_type, ar.organization_id, ar.organization_name,
              ar.request_type, ar.risk_level, ar.status, ar.requested_by_user_id,
              ar.requester_name, ar.requester_email, ar.relationship, ar.risk_reason,
              ar.reviewed_by_user_id, ar.reviewed_at, ar.review_notes,
              ar.created_at, ar.updated_at,
              COALESCE(n.slug, b.slug) AS organization_slug
       FROM organization_access_requests ar
       LEFT JOIN nonprofits n
         ON ar.organization_type = 'nonprofit' AND n.id = ar.organization_id
       LEFT JOIN businesses b
         ON ar.organization_type = 'business' AND b.id = ar.organization_id
       ${where}
       ORDER BY ar.id DESC
       LIMIT $${params.length}`,
      params,
    );

    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        organizationType: r.organization_type,
        organizationId: Number(r.organization_id),
        organizationName: r.organization_name,
        organizationSlug: r.organization_slug,
        requestType: r.request_type,
        riskLevel: r.risk_level,
        status: r.status,
        requestedByUserId: r.requested_by_user_id ? Number(r.requested_by_user_id) : null,
        requesterName: r.requester_name,
        requesterEmail: r.requester_email,
        relationship: r.relationship,
        riskReason: r.risk_reason,
        reviewedByUserId: r.reviewed_by_user_id ? Number(r.reviewed_by_user_id) : null,
        reviewedAt: r.reviewed_at,
        reviewNotes: r.review_notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load access requests" });
  }
});

superadminRouter.post("/access-requests/:id/approve", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Reuse manage approve semantics via internal HTTP-less call pattern:
    // update request + verify org.
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT * FROM organization_access_requests WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    const ar = rows[0];
    if (ar.status !== "pending") {
      res.status(400).json({ error: "Request is not pending" });
      return;
    }

    await pool.query(
      `UPDATE organization_access_requests
       SET status = 'approved', reviewed_by_user_id = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [user.id, id],
    );

    if (ar.organization_type === "nonprofit") {
      await pool.query(
        `UPDATE nonprofits
         SET verification_status = 'verified', profile_status = 'verified', updated_at = NOW()
         WHERE id = $1`,
        [ar.organization_id],
      );
    } else if (ar.organization_type === "business") {
      await pool.query(
        `UPDATE businesses
         SET claim_status = 'verified', business_status = 'active', updated_at = NOW()
         WHERE id = $1`,
        [ar.organization_id],
      );
    }

    if (ar.requested_by_user_id) {
      await pool.query(
        `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
        [ar.organization_type, ar.organization_id, ar.requested_by_user_id],
      );
    }

    res.json({ success: true, id, status: "approved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve request" });
  }
});

superadminRouter.post("/access-requests/:id/deny", async (req, res) => {
  try {
    const user = (req as typeof req & { platformAdmin: AuthUser }).platformAdmin;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { rowCount } = await pool.query(
      `UPDATE organization_access_requests
       SET status = 'denied', reviewed_by_user_id = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'`,
      [user.id, id],
    );
    if (!rowCount) {
      res.status(404).json({ error: "Pending request not found" });
      return;
    }
    // User-facing "denied" comes from this request status via auth context accessRequestStatus.
    res.json({ success: true, id, status: "denied" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deny request" });
  }
});

/**
 * Load campaign activity KPIs for a nonprofit or participating business.
 * Purpose: Superadmin View Details parity with creator dashboard/analytics.
 * Inputs: org type + id. Outputs: activitySummary + per-campaign KPI rows.
 */
async function loadOrganizationCampaignActivity(
  orgType: "nonprofit" | "business",
  orgId: number,
): Promise<{
  activitySummary: Record<string, number>;
  campaigns: Record<string, unknown>[];
}> {
  const campaignFilter =
    orgType === "nonprofit"
      ? `c.nonprofit_id = $1`
      : `EXISTS (
           SELECT 1 FROM campaign_business_locations cblx
           WHERE cblx.campaign_id = c.id AND cblx.business_id = $1
         )`;

  const { rows: campaignRows } = await pool.query<QueryResultRow>(
    `SELECT c.id, c.slug, c.campaign_name, c.campaign_status, c.campaign_goal,
            c.raised, c.supporters_going, c.expected_guests, c.verified_visits,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            c.business_timing_status, c.forkup_review_status,
            n.organization_name,
            (SELECT COALESCE(json_agg(json_build_object(
               'methodType', cm.method_type,
               'methodStatus', cm.method_status
             ) ORDER BY cm.id), '[]'::json)
             FROM campaign_methods cm WHERE cm.campaign_id = c.id) AS methods,
            (SELECT COUNT(*)::int FROM campaign_business_locations cbl
             WHERE cbl.campaign_id = c.id) AS partners_invited,
            (SELECT COUNT(*)::int FROM campaign_business_locations cbl
             WHERE cbl.campaign_id = c.id
               AND cbl.acceptance_status IN ('invited', 'pending', 'opened')) AS partners_pending,
            (SELECT COUNT(*)::int FROM campaign_business_locations cbl
             WHERE cbl.campaign_id = c.id
               AND cbl.acceptance_status = 'accepted') AS partners_accepted,
            (SELECT COUNT(*)::int FROM campaign_business_locations cbl
             WHERE cbl.campaign_id = c.id
               AND (
                 cbl.setup_status = 'needs_info'
                 OR cbl.settlement_ready_status = 'needs_info'
                 OR cbl.invite_status = 'needs_info'
               )) AS partners_needs_info,
            (SELECT COUNT(*)::int FROM campaign_participants cp
             WHERE cp.campaign_id = c.id) AS participant_count,
            (SELECT COUNT(*)::int FROM campaign_participants cp
             WHERE cp.campaign_id = c.id AND cp.participant_type = 'ambassador') AS ambassador_count,
            (SELECT COUNT(*)::int FROM receipts r WHERE r.campaign_id = c.id) AS receipts_uploaded,
            (SELECT COUNT(*)::int FROM receipts r
             WHERE r.campaign_id = c.id AND r.review_status = 'approved') AS receipts_approved,
            (SELECT COUNT(*)::int FROM receipts r
             WHERE r.campaign_id = c.id AND r.review_status = 'pending') AS receipts_pending,
            (SELECT COUNT(*)::int FROM receipts r
             WHERE r.campaign_id = c.id AND r.review_status = 'rejected') AS receipts_rejected,
            (SELECT COUNT(DISTINCT r.supporter_id)::int FROM receipts r
             WHERE r.campaign_id = c.id AND r.supporter_id IS NOT NULL) AS receipt_supporters,
            (SELECT COALESCE(SUM(r.eligible_subtotal), 0) FROM receipts r
             WHERE r.campaign_id = c.id AND r.review_status = 'approved') AS eligible_sales,
            (SELECT COALESCE(SUM(r.calculated_donation), 0) FROM receipts r
             WHERE r.campaign_id = c.id AND r.review_status = 'approved') AS giveback_pool,
            (SELECT COUNT(*)::int FROM donations d
             WHERE d.campaign_id = c.id AND d.donation_type = 'virtual') AS online_donation_count,
            (SELECT COALESCE(SUM(d.amount), 0) FROM donations d
             WHERE d.campaign_id = c.id AND d.donation_type = 'virtual') AS online_donation_total,
            (SELECT COALESCE(SUM(s.forkup_fee), 0) FROM settlements s
             WHERE s.campaign_id = c.id) AS settlement_forkup_fee,
            (SELECT COALESCE(SUM(s.net_nonprofit_amount), 0) FROM settlements s
             WHERE s.campaign_id = c.id) AS settlement_net_nonprofit,
            (SELECT COALESCE(SUM(s.donation_pool), 0) FROM settlements s
             WHERE s.campaign_id = c.id) AS settlement_donation_pool
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE ${campaignFilter}
     ORDER BY c.updated_at DESC`,
    [orgId],
  );

  const campaigns = campaignRows.map((r) => {
    let methods: { methodType: string; methodStatus: string }[] = [];
    const rawMethods = r.methods;
    if (Array.isArray(rawMethods)) {
      methods = rawMethods.map((m: { methodType?: string; method_type?: string; methodStatus?: string; method_status?: string }) => ({
        methodType: String(m.methodType ?? m.method_type ?? ""),
        methodStatus: String(m.methodStatus ?? m.method_status ?? ""),
      }));
    }

    return {
      id: Number(r.id),
      slug: String(r.slug),
      name: String(r.campaign_name),
      nonprofit: String(r.organization_name),
      status: String(r.campaign_status),
      goal: Number(r.campaign_goal ?? 0),
      raised: Number(r.raised ?? 0),
      supportersGoing: Number(r.supporters_going ?? 0),
      expectedGuests: Number(r.expected_guests ?? 0),
      verifiedVisits: Number(r.verified_visits ?? 0),
      startDate: toDateOnlyString(r.campaign_start_date),
      endDate: toDateOnlyString(r.campaign_end_date),
      eventDate: toDateOnlyString(r.event_date),
      businessTimingStatus: String(r.business_timing_status ?? "ok"),
      forkupReviewStatus: String(r.forkup_review_status ?? "none"),
      methods,
      partnersInvited: Number(r.partners_invited ?? 0),
      partnersPending: Number(r.partners_pending ?? 0),
      partnersAccepted: Number(r.partners_accepted ?? 0),
      partnersNeedsInfo: Number(r.partners_needs_info ?? 0),
      participantCount: Number(r.participant_count ?? 0),
      ambassadorCount: Number(r.ambassador_count ?? 0),
      receiptSupporters: Number(r.receipt_supporters ?? 0),
      receiptsUploaded: Number(r.receipts_uploaded ?? 0),
      receiptsApproved: Number(r.receipts_approved ?? 0),
      receiptsPending: Number(r.receipts_pending ?? 0),
      receiptsRejected: Number(r.receipts_rejected ?? 0),
      eligibleSales: Number(r.eligible_sales ?? 0),
      givebackPool: Number(r.giveback_pool ?? 0),
      onlineDonationCount: Number(r.online_donation_count ?? 0),
      onlineDonationTotal: Number(r.online_donation_total ?? 0),
      settlementForkupFee: Number(r.settlement_forkup_fee ?? 0),
      settlementNetNonprofit: Number(r.settlement_net_nonprofit ?? 0),
      settlementDonationPool: Number(r.settlement_donation_pool ?? 0),
    };
  });

  const activitySummary = {
    campaignCount: campaigns.length,
    liveCount: campaigns.filter((c) => c.status === "live").length,
    draftCount: campaigns.filter((c) =>
      ["draft", "ready_to_launch", "in_review"].includes(c.status),
    ).length,
    totalRaised: campaigns.reduce((s, c) => s + c.raised, 0),
    totalGoal: campaigns.reduce((s, c) => s + c.goal, 0),
    onlineDonationTotal: campaigns.reduce((s, c) => s + c.onlineDonationTotal, 0),
    onlineDonationCount: campaigns.reduce((s, c) => s + c.onlineDonationCount, 0),
    givebackPool: campaigns.reduce((s, c) => s + c.givebackPool, 0),
    eligibleSales: campaigns.reduce((s, c) => s + c.eligibleSales, 0),
    supporters: campaigns.reduce((s, c) => s + c.receiptSupporters, 0),
    supportersGoing: campaigns.reduce((s, c) => s + c.supportersGoing, 0),
    receiptsUploaded: campaigns.reduce((s, c) => s + c.receiptsUploaded, 0),
    receiptsApproved: campaigns.reduce((s, c) => s + c.receiptsApproved, 0),
    partnersInvited: campaigns.reduce((s, c) => s + c.partnersInvited, 0),
    partnersAccepted: campaigns.reduce((s, c) => s + c.partnersAccepted, 0),
    ambassadorCount: campaigns.reduce((s, c) => s + c.ambassadorCount, 0),
    settlementForkupFee: campaigns.reduce((s, c) => s + c.settlementForkupFee, 0),
    settlementNetNonprofit: campaigns.reduce((s, c) => s + c.settlementNetNonprofit, 0),
  };

  return { activitySummary, campaigns };
}

/**
 * GET /api/superadmin/organizations/:type/:id
 * query: requestId? — optional access-request id to include in the payload
 * response: {
 *   organizationType: "nonprofit" | "business",
 *   organization: { ...full profile fields... },
 *   locations?: [...],  // business only
 *   accessRequest: AccessRequest | null,
 *   activitySummary: { ...totals... },
 *   campaigns: [ ...per-campaign KPIs... ]
 * }
 */
superadminRouter.get("/organizations/:type/:id", async (req, res) => {
  try {
    const orgType = String(req.params.type || "").trim().toLowerCase();
    const orgId = Number(req.params.id);
    if (orgType !== "nonprofit" && orgType !== "business") {
      res.status(400).json({ error: "type must be nonprofit or business" });
      return;
    }
    if (!Number.isFinite(orgId) || orgId <= 0) {
      res.status(400).json({ error: "Invalid organization id" });
      return;
    }

    const requestIdRaw = typeof req.query.requestId === "string" ? Number(req.query.requestId) : NaN;

    let accessRequest: Record<string, unknown> | null = null;
    if (Number.isFinite(requestIdRaw) && requestIdRaw > 0) {
      const { rows: arRows } = await pool.query<QueryResultRow>(
        `SELECT ar.id, ar.organization_type, ar.organization_id, ar.organization_name,
                ar.request_type, ar.risk_level, ar.status, ar.requested_by_user_id,
                ar.requester_name, ar.requester_email, ar.relationship, ar.risk_reason,
                ar.reviewed_by_user_id, ar.reviewed_at, ar.review_notes,
                ar.created_at, ar.updated_at,
                COALESCE(n.slug, b.slug) AS organization_slug
         FROM organization_access_requests ar
         LEFT JOIN nonprofits n
           ON ar.organization_type = 'nonprofit' AND n.id = ar.organization_id
         LEFT JOIN businesses b
           ON ar.organization_type = 'business' AND b.id = ar.organization_id
         WHERE ar.id = $1
         LIMIT 1`,
        [requestIdRaw],
      );
      if (arRows[0]) {
        const r = arRows[0];
        accessRequest = {
          id: Number(r.id),
          organizationType: r.organization_type,
          organizationId: r.organization_id != null ? Number(r.organization_id) : null,
          organizationName: r.organization_name,
          organizationSlug: r.organization_slug,
          requestType: r.request_type,
          riskLevel: r.risk_level,
          status: r.status,
          requestedByUserId: r.requested_by_user_id ? Number(r.requested_by_user_id) : null,
          requesterName: r.requester_name,
          requesterEmail: r.requester_email,
          relationship: r.relationship,
          riskReason: r.risk_reason,
          reviewedByUserId: r.reviewed_by_user_id ? Number(r.reviewed_by_user_id) : null,
          reviewedAt: r.reviewed_at,
          reviewNotes: r.review_notes,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }
    }

    if (orgType === "nonprofit") {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT * FROM nonprofits WHERE id = $1 LIMIT 1`,
        [orgId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Nonprofit not found" });
        return;
      }
      const n = rows[0];
      const activity = await loadOrganizationCampaignActivity("nonprofit", orgId);
      res.json({
        organizationType: "nonprofit",
        organization: {
          id: Number(n.id),
          organizationName: n.organization_name,
          slug: n.slug,
          logoUrl: n.logo_url ?? null,
          mission: n.mission,
          description: n.description ?? null,
          website: n.website,
          contactName: n.contact_name,
          contactEmail: n.contact_email,
          contactPhone: n.contact_phone,
          causeCategory: n.cause_category,
          ein: n.ein ?? null,
          city: n.city ?? null,
          state: n.state ?? null,
          zip: n.zip ?? null,
          verificationStatus: n.verification_status,
          claimStatus: n.claim_status,
          profileStatus: n.profile_status ?? "preloaded",
          facebookUrl: n.facebook_url ?? null,
          instagramUrl: n.instagram_url ?? null,
          linkedinUrl: n.linkedin_url ?? null,
          tiktokUrl: n.tiktok_url ?? null,
          youtubeUrl: n.youtube_url ?? null,
          claimedByUserId: n.claimed_by_user_id != null ? Number(n.claimed_by_user_id) : null,
          claimDate: n.claim_date ?? null,
          verificationDate: n.verification_date ?? null,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
        },
        accessRequest,
        activitySummary: activity.activitySummary,
        campaigns: activity.campaigns,
      });
      return;
    }

    const { rows: bizRows } = await pool.query<QueryResultRow>(
      `SELECT * FROM businesses WHERE id = $1 LIMIT 1`,
      [orgId],
    );
    if (bizRows.length === 0) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const b = bizRows[0];
    const { rows: locations } = await pool.query<QueryResultRow>(
      `SELECT id, location_name, address, city, state, zip, phone, website_url,
              reservation_url, booking_url, active_status, created_at, updated_at
       FROM business_locations WHERE business_id = $1 ORDER BY location_name`,
      [orgId],
    );

    const activity = await loadOrganizationCampaignActivity("business", orgId);

    res.json({
      organizationType: "business",
      organization: {
        id: Number(b.id),
        businessName: b.business_name,
        slug: b.slug,
        businessType: b.business_type,
        logoUrl: b.logo_url ?? null,
        description: b.description ?? null,
        website: b.website,
        contactName: b.contact_name,
        contactEmail: b.contact_email,
        contactPhone: b.contact_phone,
        businessStatus: b.business_status,
        claimStatus: b.claim_status,
        profileStatus: b.profile_status ?? b.business_status,
        defaultGivebackPercentage:
          b.default_giveback_percentage != null ? Number(b.default_giveback_percentage) : 10,
        supportsDineAndDonate: Boolean(b.supports_dine_and_donate),
        supportsShopAndDonate: Boolean(b.supports_shop_and_donate),
        supportsServiceGiveback: Boolean(b.supports_service_giveback),
        supportsGuestBartending: Boolean(b.supports_guest_bartending),
        facebookUrl: b.facebook_url ?? null,
        instagramUrl: b.instagram_url ?? null,
        linkedinUrl: b.linkedin_url ?? null,
        tiktokUrl: b.tiktok_url ?? null,
        claimedByUserId: b.claimed_by_user_id != null ? Number(b.claimed_by_user_id) : null,
        claimDate: b.claim_date ?? null,
        verificationDate: b.verification_date ?? null,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
      },
      locations: locations.map((l) => ({
        id: Number(l.id),
        locationName: l.location_name,
        address: l.address,
        city: l.city,
        state: l.state,
        zip: l.zip,
        phone: l.phone,
        websiteUrl: l.website_url,
        reservationUrl: l.reservation_url,
        bookingUrl: l.booking_url,
        activeStatus: l.active_status,
        createdAt: l.created_at,
        updatedAt: l.updated_at,
      })),
      accessRequest,
      activitySummary: activity.activitySummary,
      campaigns: activity.campaigns,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load organization details" });
  }
});

// ── Directory (v1 admin parity — list/view) ───────────────────────────────────

function parseListQuery(req: { query: Record<string, unknown> }) {
  const search =
    typeof req.query.search === "string" ? req.query.search.trim() : "";
  const limitRaw = Number(req.query.limit ?? 50);
  const offsetRaw = Number(req.query.offset ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  return { search, limit, offset };
}

/**
 * GET /overview
 * Platform counts for Super Admin dashboard strip.
 */
superadminRouter.get("/overview", async (_req, res) => {
  try {
    const [users, nonprofits, businesses, campaigns, fundraisers, donations] =
      await Promise.all([
        pool.query<QueryResultRow>(`SELECT COUNT(*)::int AS c FROM users`),
        pool.query<QueryResultRow>(`SELECT COUNT(*)::int AS c FROM nonprofits`),
        pool.query<QueryResultRow>(`SELECT COUNT(*)::int AS c FROM businesses`),
        pool.query<QueryResultRow>(`SELECT COUNT(*)::int AS c FROM campaigns`),
        pool.query<QueryResultRow>(
          `SELECT COUNT(DISTINCT user_id)::int AS c FROM campaign_fundraisers`,
        ),
        pool.query<QueryResultRow>(`SELECT COUNT(*)::int AS c FROM donations`),
      ]);
    res.json({
      users: users.rows[0]?.c ?? 0,
      nonprofits: nonprofits.rows[0]?.c ?? 0,
      businesses: businesses.rows[0]?.c ?? 0,
      campaigns: campaigns.rows[0]?.c ?? 0,
      fundraisers: fundraisers.rows[0]?.c ?? 0,
      donations: donations.rows[0]?.c ?? 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load overview" });
  }
});

/**
 * GET /users
 * Paginated user directory with org memberships + platform-admin flag.
 */
superadminRouter.get("/users", async (req, res) => {
  try {
    const { search, limit, offset } = parseListQuery(req);
    const params: unknown[] = [];
    let where = "";
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE LOWER(u.email) LIKE $1
               OR LOWER(COALESCE(u.full_name, '')) LIKE $1
               OR LOWER(COALESCE(u.username, '')) LIKE $1`;
    }
    const countSql = `SELECT COUNT(*)::int AS c FROM users u ${where}`;
    const { rows: countRows } = await pool.query<QueryResultRow>(countSql, params);
    const listParams = [...params, limit, offset];
    const limIdx = params.length + 1;
    const offIdx = params.length + 2;
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT u.id, u.email, u.full_name, u.username,
              COALESCE(u.is_platform_admin, FALSE) AS is_platform_admin,
              u.created_at, u.updated_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'organizationType', ou.organization_type,
                  'organizationId', ou.organization_id,
                  'role', ou.role
                ) ORDER BY ou.organization_type, ou.organization_id)
                FROM organization_users ou WHERE ou.user_id = u.id
              ), '[]'::json) AS memberships
       FROM users u
       ${where}
       ORDER BY u.id DESC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams,
    );
    res.json({
      totalCount: countRows[0]?.c ?? 0,
      users: rows.map((r) => ({
        id: Number(r.id),
        email: r.email,
        fullName: r.full_name ?? null,
        username: r.username ?? null,
        isPlatformAdmin: Boolean(r.is_platform_admin),
        memberships: Array.isArray(r.memberships) ? r.memberships : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load users" });
  }
});

/**
 * GET /roles
 * Role catalog for v2 (no separate roles table) + live counts.
 */
superadminRouter.get("/roles", async (_req, res) => {
  try {
    const [platform, orgRoles, fundraiser] = await Promise.all([
      pool.query<QueryResultRow>(
        `SELECT COUNT(*)::int AS c FROM users WHERE COALESCE(is_platform_admin, FALSE) = TRUE`,
      ),
      pool.query<QueryResultRow>(
        `SELECT organization_type, role, COUNT(*)::int AS c
         FROM organization_users
         GROUP BY organization_type, role
         ORDER BY organization_type, role`,
      ),
      pool.query<QueryResultRow>(
        `SELECT COUNT(DISTINCT user_id)::int AS c FROM campaign_fundraisers`,
      ),
    ]);
    res.json({
      roles: [
        {
          id: "platform_admin",
          roleName: "platform_admin",
          description: "Full platform Super Admin access",
          userCount: platform.rows[0]?.c ?? 0,
        },
        {
          id: "fundraiser",
          roleName: "fundraiser",
          description: "Campaign co-organizer / fundraiser invite sender",
          userCount: fundraiser.rows[0]?.c ?? 0,
        },
        ...orgRoles.rows.map((r) => ({
          id: `${r.organization_type}:${r.role}`,
          roleName: `${r.organization_type}_${r.role}`,
          description: `${String(r.organization_type)} organization ${String(r.role)}`,
          userCount: r.c ?? 0,
        })),
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load roles" });
  }
});

/**
 * GET /nonprofits
 */
superadminRouter.get("/nonprofits", async (req, res) => {
  try {
    const { search, limit, offset } = parseListQuery(req);
    const params: unknown[] = [];
    let where = "";
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE LOWER(organization_name) LIKE $1
               OR LOWER(COALESCE(slug, '')) LIKE $1
               OR LOWER(COALESCE(contact_email, '')) LIKE $1
               OR LOWER(COALESCE(ein, '')) LIKE $1`;
    }
    const { rows: countRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS c FROM nonprofits ${where}`,
      params,
    );
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, organization_name, slug, logo_url, website, contact_name, contact_email,
              contact_phone, city, state, ein, verification_status, claim_status,
              profile_status, created_at, updated_at
       FROM nonprofits
       ${where}
       ORDER BY id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams,
    );
    res.json({
      totalCount: countRows[0]?.c ?? 0,
      nonprofits: rows.map((n) => ({
        id: Number(n.id),
        organizationName: n.organization_name,
        slug: n.slug,
        logoUrl: n.logo_url ?? null,
        website: n.website ?? null,
        contactName: n.contact_name ?? null,
        contactEmail: n.contact_email ?? null,
        contactPhone: n.contact_phone ?? null,
        city: n.city ?? null,
        state: n.state ?? null,
        ein: n.ein ?? null,
        verificationStatus: n.verification_status ?? null,
        claimStatus: n.claim_status ?? null,
        profileStatus: n.profile_status ?? null,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load nonprofits" });
  }
});

/**
 * GET /businesses
 * Includes location count + ACH-on-file summary (masked last4 only).
 */
superadminRouter.get("/businesses", async (req, res) => {
  try {
    const { search, limit, offset } = parseListQuery(req);
    const params: unknown[] = [];
    let where = "";
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE LOWER(b.business_name) LIKE $1
               OR LOWER(COALESCE(b.slug, '')) LIKE $1
               OR LOWER(COALESCE(b.contact_email, '')) LIKE $1`;
    }
    const { rows: countRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS c FROM businesses b ${where}`,
      params,
    );
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT b.id, b.business_name, b.slug, b.business_type, b.logo_url, b.website,
              b.contact_name, b.contact_email, b.contact_phone,
              b.business_status, b.claim_status, b.profile_status,
              b.created_at, b.updated_at,
              (SELECT COUNT(*)::int FROM business_locations bl WHERE bl.business_id = b.id) AS location_count,
              (SELECT COUNT(*)::int FROM business_locations bl
                WHERE bl.business_id = b.id
                  AND (bl.ach_account_last4 IS NOT NULL OR bl.ach_bank_name IS NOT NULL)
              ) AS ach_location_count
       FROM businesses b
       ${where}
       ORDER BY b.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams,
    );

    const businessIds = rows.map((r) => Number(r.id));
    const locationsByBiz = new Map<number, QueryResultRow[]>();
    if (businessIds.length > 0) {
      const { rows: locRows } = await pool.query<QueryResultRow>(
        `SELECT id, business_id, location_name, city, state,
                ach_bank_name, ach_account_last4, ach_authorization_status,
                ach_signature_path
         FROM business_locations
         WHERE business_id = ANY($1::int[])
         ORDER BY location_name`,
        [businessIds],
      );
      for (const loc of locRows) {
        const bid = Number(loc.business_id);
        const list = locationsByBiz.get(bid) ?? [];
        list.push(loc);
        locationsByBiz.set(bid, list);
      }
    }

    res.json({
      totalCount: countRows[0]?.c ?? 0,
      businesses: rows.map((b) => {
        const locs = locationsByBiz.get(Number(b.id)) ?? [];
        return {
          id: Number(b.id),
          businessName: b.business_name,
          slug: b.slug,
          businessType: b.business_type ?? null,
          logoUrl: b.logo_url ?? null,
          website: b.website ?? null,
          contactName: b.contact_name ?? null,
          contactEmail: b.contact_email ?? null,
          contactPhone: b.contact_phone ?? null,
          businessStatus: b.business_status ?? null,
          claimStatus: b.claim_status ?? null,
          profileStatus: b.profile_status ?? null,
          locationCount: Number(b.location_count ?? 0),
          achLocationCount: Number(b.ach_location_count ?? 0),
          locations: locs.map((l) => ({
            id: Number(l.id),
            locationName: l.location_name,
            city: l.city ?? null,
            state: l.state ?? null,
            achBankName: l.ach_bank_name ?? null,
            achAccountLast4: l.ach_account_last4 ?? null,
            achAuthorizationStatus: l.ach_authorization_status ?? null,
            hasAchData: Boolean(l.ach_bank_name || l.ach_account_last4),
            hasSignature: Boolean(l.ach_signature_path),
          })),
          createdAt: b.created_at,
          updatedAt: b.updated_at,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load businesses" });
  }
});

/**
 * GET /campaigns
 * All campaign statuses (broader than live-campaigns tab).
 */
superadminRouter.get("/campaigns", async (req, res) => {
  try {
    const { search, limit, offset } = parseListQuery(req);
    const status =
      typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      clauses.push(
        `(LOWER(c.campaign_name) LIKE $${params.length} OR LOWER(COALESCE(c.slug, '')) LIKE $${params.length}
          OR LOWER(COALESCE(n.organization_name, '')) LIKE $${params.length})`,
      );
    }
    if (status) {
      params.push(status);
      clauses.push(`LOWER(c.campaign_status) = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows: countRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS c
       FROM campaigns c
       LEFT JOIN nonprofits n ON n.id = c.nonprofit_id
       ${where}`,
      params,
    );
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT c.id, c.slug, c.campaign_name, c.campaign_goal, c.campaign_status,
              c.campaign_start_date, c.campaign_end_date, c.raised,
              c.created_at, c.updated_at,
              n.organization_name AS nonprofit_name
       FROM campaigns c
       LEFT JOIN nonprofits n ON n.id = c.nonprofit_id
       ${where}
       ORDER BY c.updated_at DESC NULLS LAST, c.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams,
    );
    res.json({
      totalCount: countRows[0]?.c ?? 0,
      campaigns: rows.map((c) => ({
        id: Number(c.id),
        slug: c.slug,
        name: c.campaign_name,
        nonprofit: c.nonprofit_name ?? null,
        status: c.campaign_status ?? null,
        goal: c.campaign_goal != null ? Number(c.campaign_goal) : null,
        raised: Number(c.raised ?? 0),
        startDate: c.campaign_start_date
          ? String(c.campaign_start_date).slice(0, 10)
          : null,
        endDate: c.campaign_end_date ? String(c.campaign_end_date).slice(0, 10) : null,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load campaigns" });
  }
});

/**
 * GET /fundraisers
 * Distinct users linked via campaign_fundraisers (+ invite activity).
 */
superadminRouter.get("/fundraisers", async (req, res) => {
  try {
    const { search, limit, offset } = parseListQuery(req);
    const params: unknown[] = [];
    let searchClause = "";
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      searchClause = `AND (LOWER(u.email) LIKE $1 OR LOWER(COALESCE(u.full_name, '')) LIKE $1)`;
    }
    const { rows: countRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT DISTINCT cf.user_id
         FROM campaign_fundraisers cf
         JOIN users u ON u.id = cf.user_id
         WHERE 1=1 ${searchClause}
       ) t`,
      params,
    );
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT u.id, u.email, u.full_name, u.created_at,
              COUNT(DISTINCT cf.campaign_id)::int AS campaign_count,
              MAX(cf.status) AS sample_status
       FROM campaign_fundraisers cf
       JOIN users u ON u.id = cf.user_id
       WHERE 1=1 ${searchClause}
       GROUP BY u.id, u.email, u.full_name, u.created_at
       ORDER BY campaign_count DESC, u.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams,
    );
    res.json({
      totalCount: countRows[0]?.c ?? 0,
      fundraisers: rows.map((r) => ({
        id: Number(r.id),
        email: r.email,
        fullName: r.full_name ?? null,
        campaignCount: Number(r.campaign_count ?? 0),
        status: r.sample_status ?? null,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load fundraisers" });
  }
});

/**
 * GET /donations
 * Recent donations list (read-only).
 */
superadminRouter.get("/donations", async (req, res) => {
  try {
    const { limit, offset } = parseListQuery(req);
    const { rows: countRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS c FROM donations`,
    );
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT d.id, d.amount, d.donation_type, d.payment_status, d.created_at,
              c.campaign_name AS campaign_name, c.slug AS campaign_slug
       FROM donations d
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       ORDER BY d.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({
      totalCount: countRows[0]?.c ?? 0,
      donations: rows.map((d) => ({
        id: Number(d.id),
        amount: Number(d.amount ?? 0),
        donationType: d.donation_type ?? null,
        paymentStatus: d.payment_status ?? null,
        campaignName: d.campaign_name ?? null,
        campaignSlug: d.campaign_slug ?? null,
        createdAt: d.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load donations" });
  }
});

/** Exported for mailer SMTP transport building (avoids circular imports in tests). */
export async function buildSmtpTransportFromSettings() {
  const s = await getPlatformSettings([
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_pass",
    "smtp_secure",
  ]);
  if (!s.smtp_host?.trim()) return null;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port || 587),
    secure: s.smtp_secure === "true",
    auth:
      s.smtp_user && s.smtp_pass
        ? { user: s.smtp_user, pass: s.smtp_pass }
        : undefined,
  });
}
