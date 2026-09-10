import { Router } from "express";
import crypto from "crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  bearerToken,
  generateSessionToken,
  hashPassword,
  resolveAuthUser,
  sessionExpiry,
  verifyPassword,
} from "../lib/auth";
import { pool } from "../db/pool";
import {
  loadUserBusinessProfiles,
  loadUserNonprofitProfiles,
} from "../lib/auth-profiles";
import { assertUserMayLinkOrganization } from "../lib/assert-may-link-organization";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";

export const authRouter = Router();

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

authRouter.get("/check-email", async (req, res) => {
  try {
    const email = normalizeEmail(typeof req.query.email === "string" ? req.query.email : "");
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    if (!isValidEmail(email)) {
      res.json({ available: false, valid: false, message: "Enter a valid email address" });
      return;
    }

    const { rows: existing } = await pool.query<QueryResultRow>(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );

    res.json({
      valid: true,
      available: existing.length === 0,
      message:
        existing.length > 0
          ? "An account with this email already exists. Please sign in instead."
          : "Email is available",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to check email" });
  }
});

authRouter.get("/context", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const nonprofitProfiles = await loadUserNonprofitProfiles(user);
    const businessProfiles = await loadUserBusinessProfiles(user);

    res.json({
      user,
      nonprofitProfiles,
      businessProfiles,
      nonprofitProfile: nonprofitProfiles[0] ?? null,
      businessProfile: businessProfiles[0] ?? null,
    });
  } catch (err) {
    console.error("GET /auth/context failed:", err);
    const message = err instanceof Error ? err.message : "Failed to load session context";
    res.status(500).json({ error: message });
  }
});

authRouter.post("/register", async (req, res) => {
  try {
    const { email, password, fullName, organizationType, organizationId, role } = req.body as {
      email?: string;
      password?: string;
      fullName?: string;
      organizationType?: "nonprofit" | "business";
      organizationId?: number;
      role?: string;
    };

    const normalizedEmail = normalizeEmail(email ?? "");
    if (!isValidEmail(normalizedEmail)) {
      res.status(400).json({ error: "Enter a valid email address" });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const { rows: existing } = await pool.query<QueryResultRow>(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail],
    );
    if (existing.length > 0) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    // Guard before creating the user so a rejected org link cannot orphan a row.
    // New accounts use a non-matching userId so only unclaimed / memberless orgs pass.
    if (organizationType && organizationId) {
      const preLink = await assertUserMayLinkOrganization(pool, {
        userId: -1,
        organizationType,
        organizationId: Number(organizationId),
      });
      if (!preLink.ok) {
        res.status(preLink.status).json({ error: preLink.error });
        return;
      }
    }

    const passwordHash = await hashPassword(password);
    const { rows: userResult } = await pool.query<{ id: number }>(
      "INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id",
      [normalizedEmail, passwordHash, fullName?.trim() ?? null],
    );
    const userId = userResult[0].id;

    if (organizationType && organizationId) {
      const orgRole = ["owner", "admin", "manager", "viewer"].includes(role ?? "")
        ? role
        : "admin";
      await pool.query(
        `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
         VALUES ($1, $2, $3, $4)`,
        [organizationType, organizationId, userId, orgRole],
      );
    }

    const token = generateSessionToken();
    await pool.query(
      "INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, token, sessionExpiry()],
    );

    const user = await resolveAuthUser(token);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const normalizedEmail = normalizeEmail(email ?? "");
    if (!isValidEmail(normalizedEmail) || !password) {
      res.status(400).json({ error: "Enter a valid email and password" });
      return;
    }

    const { rows: rows } = await pool.query<QueryResultRow>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [normalizedEmail],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await verifyPassword(password, String(rows[0].password_hash ?? ""));
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = generateSessionToken();
    await pool.query(
      "INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [rows[0].id, token, sessionExpiry()],
    );

    const user = await resolveAuthUser(token);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

authRouter.post("/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token) {
      await pool.query("DELETE FROM auth_sessions WHERE token = $1", [token]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Logout failed" });
  }
});

authRouter.get("/me", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

authRouter.post("/link-organization", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const { organizationType, organizationId, role } = req.body as {
      organizationType?: "nonprofit" | "business";
      organizationId?: number;
      role?: string;
    };

    if (!organizationType || !organizationId) {
      res.status(400).json({ error: "organizationType and organizationId are required" });
      return;
    }

    const mayLink = await assertUserMayLinkOrganization(pool, {
      userId: user.id,
      organizationType,
      organizationId: Number(organizationId),
    });
    if (!mayLink.ok) {
      res.status(mayLink.status).json({ error: mayLink.error });
      return;
    }

    const orgRole = ["owner", "admin", "manager", "viewer"].includes(role ?? "")
      ? role
      : "admin";

    await pool.query(
      `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_type, organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [organizationType, organizationId, user.id, orgRole],
    );

    const updated = await resolveAuthUser(bearerToken(req));
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to link organization" });
  }
});

/**
 * POST /api/auth/forgot-password
 * body: { email: string }
 * response: { success: boolean, message: string }
 *
 * Always returns a generic success message (does not reveal whether the email
 * exists). When a matching user is found, inserts a password_reset_tokens row
 * with a long URL token + 6-digit code and emails both (valid 1 hour).
 */
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(
      typeof req.body?.email === "string" ? req.body.email : "",
    );
    const generic = {
      success: true,
      message:
        "If an account matches, a password reset link and code have been sent to that email.",
    };
    if (!isValidEmail(normalizedEmail)) {
      res.json(generic);
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, email, full_name FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail],
    );
    if (rows.length === 0) {
      res.json(generic);
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const code = String(crypto.randomInt(100000, 1000000));
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, code, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [rows[0].id, token, code, expires],
    );

    const base = resolveFrontendBaseUrl();
    const resetUrl = `${base}/?step=auth-reset-password&token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: String(rows[0].email),
      name: rows[0].full_name,
      subject: "Reset your ForkUp password",
      body:
        `Reset your ForkUp password using this link (valid 1 hour):\n\n${resetUrl}\n\n` +
        `Or enter this code on the reset page: ${code}\n\n` +
        `If you did not request this, you can ignore this email.`,
      emailType: "user_password_reset",
      stakeholderRole: "supporter",
      relatedToken: token,
    });

    res.json(generic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to process forgot-password request" });
  }
});

/**
 * POST /api/auth/verify-reset-code
 * body: { email: string, code: string }
 * response: { token: string }
 *
 * Validates the 6-digit code for the given email and returns the long reset
 * token so the client can call /reset-password (same as following the email link).
 */
authRouter.post("/verify-reset-code", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(
      typeof req.body?.email === "string" ? req.body.email : "",
    );
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!isValidEmail(normalizedEmail) || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "Valid email and 6-digit code are required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT prt.token, prt.expires_at, prt.used_at
       FROM password_reset_tokens prt
       INNER JOIN users u ON u.id = prt.user_id
       WHERE u.email = $1
         AND prt.code = $2
       ORDER BY prt.created_at DESC
       LIMIT 1`,
      [normalizedEmail, code],
    );
    if (rows.length === 0) {
      res.status(400).json({ error: "Invalid or expired reset code" });
      return;
    }
    if (rows[0].used_at || new Date(rows[0].expires_at) < new Date()) {
      res.status(400).json({ error: "Invalid or expired reset code" });
      return;
    }

    res.json({ token: String(rows[0].token) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to verify reset code" });
  }
});

/**
 * POST /api/auth/reset-password
 * body: { token: string, password: string }
 * response: { success: boolean }
 *
 * Consumes a valid unused reset token and updates users.password_hash.
 */
authRouter.post("/reset-password", async (req, res) => {
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
