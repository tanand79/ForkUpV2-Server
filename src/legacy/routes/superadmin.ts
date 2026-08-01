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
 * GET     /api/superadmin/organizations/:type/:id
 *   query: requestId? (optional access-request id to include)
 *   response: { organizationType, organization, locations?, accessRequest }
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

export const superadminRouter = Router();

const AI_MODELS = [
  {
    id: "amazon.nova-micro-v1:0",
    label: "Nova Micro",
    vendor: "Amazon",
    tier: "Lite",
    blurb: "Fastest & lowest cost",
    inputPer1M: 0.035,
    outputPer1M: 0.14,
  },
  {
    id: "amazon.nova-lite-v1:0",
    label: "Nova Lite",
    vendor: "Amazon",
    tier: "Balanced",
    blurb: "Fast & balanced",
    inputPer1M: 0.06,
    outputPer1M: 0.24,
  },
  {
    id: "amazon.nova-pro-v1:0",
    label: "Nova Pro",
    vendor: "Amazon",
    tier: "Pro",
    blurb: "Deeper reasoning on Bedrock",
    inputPer1M: 0.8,
    outputPer1M: 3.2,
  },
  {
    id: "anthropic.claude-haiku-4-5-20251001-v1:0",
    label: "Claude Haiku 4.5",
    vendor: "Anthropic",
    tier: "Lite",
    blurb: "Fast Claude responses",
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
  {
    id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Claude Sonnet 4.5",
    vendor: "Anthropic",
    tier: "Balanced",
    blurb: "Balanced Claude reasoning",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  {
    id: "anthropic.claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    tier: "Pro",
    blurb: "Best draft quality",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
] as const;

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
    const settings = await getPlatformSettings(["ai_model_id"]);
    const selected =
      settings.ai_model_id || process.env.BEDROCK_MODEL_ID?.trim() || "amazon.nova-lite-v1:0";
    // Live AWS Price List rates when credentials allow; else hardcoded fallbacks.
    const pricing = await getBedrockLivePricing(AI_MODELS);
    const rateById = new Map(pricing.rates.map((r) => [r.modelId, r]));
    res.json({
      selectedModelId: selected,
      pricingSource: pricing.pricingSource,
      pricingFetchedAt: pricing.pricingFetchedAt,
      models: AI_MODELS.map((m) => {
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
        };
      }),
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
    if (!AI_MODELS.some((m) => m.id === modelId)) {
      res.status(400).json({ error: "Unknown AI model" });
      return;
    }
    await setPlatformSettings({ ai_model_id: modelId }, user.id);
    res.json({ success: true, selectedModelId: modelId });
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
 * GET /api/superadmin/organizations/:type/:id
 * query: requestId? — optional access-request id to include in the payload
 * response: {
 *   organizationType: "nonprofit" | "business",
 *   organization: { ...full profile fields... },
 *   locations?: [...],  // business only
 *   accessRequest: AccessRequest | null
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
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load organization details" });
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
