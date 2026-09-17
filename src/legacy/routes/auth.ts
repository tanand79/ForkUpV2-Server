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
import { linkGuestBusinessesForVerifiedUser } from "../lib/link-guest-businesses-on-verify";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";

export const authRouter = Router();

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

/** Product accounts only (Pass 2 staff/product email split). */
const PRODUCT_USER_SQL = `COALESCE(is_platform_admin, FALSE) = FALSE`;
const PRODUCT_USER_U_SQL = `COALESCE(u.is_platform_admin, FALSE) = FALSE`;

/** Staff / platform-admin accounts only. */
const STAFF_USER_SQL = `COALESCE(is_platform_admin, FALSE) = TRUE`;

/**
 * Sends verification email for a pending signup (no users row yet).
 * Inputs: email, fullName, token, code.
 * Outputs: void (errors propagate to caller).
 */
async function sendPendingSignupEmail(
  email: string,
  fullName: string | null,
  token: string,
  code: string,
): Promise<void> {
  const base = resolveFrontendBaseUrl();
  const verifyUrl = `${base}/?step=auth-verify-email&token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: email,
    name: fullName,
    subject: "Verify your ForkUp email",
    body:
      `Welcome to ForkUp! Verify your email using this link (valid 1 hour):\n\n${verifyUrl}\n\n` +
      `Or enter this code on the verification page: ${code}\n\n` +
      `If you did not create an account, you can ignore this email.`,
    emailType: "user_email_verification",
    stakeholderRole: "supporter",
    relatedToken: token,
  });
}

/**
 * Legacy path: verification tokens for users already created before pending_signups.
 * Inputs: userId, email, optional display name.
 * Outputs: void (errors propagate to caller).
 */
async function createAndSendEmailVerification(
  userId: number,
  email: string,
  fullName: string | null,
): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token, code, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, token, code, expires],
  );
  await sendPendingSignupEmail(email, fullName, token, code);
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
      `SELECT id FROM users WHERE email = $1 AND ${PRODUCT_USER_SQL}`,
      [email],
    );
    const { rows: pending } = await pool.query<QueryResultRow>(
      `SELECT id FROM pending_signups
       WHERE LOWER(email) = $1 AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [email],
    );

    const taken = existing.length > 0 || pending.length > 0;
    res.json({
      valid: true,
      available: !taken,
      message: taken
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
      `SELECT id FROM users WHERE email = $1 AND ${PRODUCT_USER_SQL}`,
      [normalizedEmail],
    );
    if (existing.length > 0) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    // Guard before staging signup so a rejected org link never creates a pending row.
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

    const orgRole =
      organizationType && organizationId
        ? ["owner", "admin", "manager", "viewer"].includes(role ?? "")
          ? role
          : "admin"
        : null;

    const passwordHash = await hashPassword(password);
    const token = crypto.randomBytes(32).toString("hex");
    const code = String(crypto.randomInt(100000, 1000000));
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    const name = fullName?.trim() ?? null;

    // Replace any unused pending signup for this email (abandoned attempts).
    await pool.query(
      `DELETE FROM pending_signups WHERE LOWER(email) = $1 AND used_at IS NULL`,
      [normalizedEmail],
    );

    await pool.query(
      `INSERT INTO pending_signups (
         email, password_hash, full_name,
         organization_type, organization_id, organization_role,
         token, code, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        normalizedEmail,
        passwordHash,
        name,
        organizationType && organizationId ? organizationType : null,
        organizationType && organizationId ? Number(organizationId) : null,
        orgRole,
        token,
        code,
        expires,
      ],
    );

    try {
      await sendPendingSignupEmail(normalizedEmail, name, token, code);
    } catch (mailErr) {
      console.error("Signup verification email failed:", mailErr);
    }

    // No users row and no session until /verify-email succeeds.
    res.status(201).json({
      pendingVerification: true,
      email: normalizedEmail,
      message: "Check your email for a verification link and 6-digit code.",
    });
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

    // Product login only — staff must use /api/superadmin/login.
    const { rows: productRows } = await pool.query<QueryResultRow>(
      `SELECT id, password_hash FROM users
       WHERE email = $1 AND ${PRODUCT_USER_SQL}
       LIMIT 1`,
      [normalizedEmail],
    );
    if (productRows.length === 0) {
      const { rows: staffRows } = await pool.query<QueryResultRow>(
        `SELECT id FROM users WHERE email = $1 AND ${STAFF_USER_SQL} LIMIT 1`,
        [normalizedEmail],
      );
      if (staffRows.length > 0) {
        res.status(403).json({
          error:
            "This email is a staff account. Use the staff / superadmin sign-in instead.",
        });
        return;
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await verifyPassword(
      password,
      String(productRows[0].password_hash ?? ""),
    );
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = generateSessionToken();
    await pool.query(
      "INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [productRows[0].id, token, sessionExpiry()],
    );

    // Best-effort: attach guest Join Us drafts saved under this email.
    try {
      await linkGuestBusinessesForVerifiedUser(
        Number(productRows[0].id),
        normalizedEmail,
      );
    } catch (linkErr) {
      console.error("guest business link on login failed:", linkErr);
    }

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
      `SELECT id, email, full_name FROM users
       WHERE email = $1 AND ${PRODUCT_USER_SQL}
       LIMIT 1`,
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
         AND ${PRODUCT_USER_U_SQL}
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

/**
 * POST /api/auth/verify-email
 * body: { token: string } OR { email: string, code: string }
 * response (pending signup): { success, emailVerified, token, user }
 * response (legacy user token): { success, emailVerified }
 *
 * Prefer pending_signups (creates users row only after verify). Falls back to
 * email_verification_tokens for accounts created before pending_signups.
 */
authRouter.post("/verify-email", async (req, res) => {
  try {
    const token =
      typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const normalizedEmail = normalizeEmail(
      typeof req.body?.email === "string" ? req.body.email : "",
    );
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : "";

    let pending: QueryResultRow | undefined;
    if (token) {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT *
         FROM pending_signups
         WHERE token = $1
         LIMIT 1`,
        [token],
      );
      pending = rows[0];
    } else if (isValidEmail(normalizedEmail) && /^\d{6}$/.test(code)) {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT *
         FROM pending_signups
         WHERE LOWER(email) = $1
           AND code = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [normalizedEmail, code],
      );
      pending = rows[0];
    } else {
      res.status(400).json({
        error: "Provide a verification token, or email plus 6-digit code",
      });
      return;
    }

    if (pending) {
      if (pending.used_at || new Date(pending.expires_at) < new Date()) {
        res.status(400).json({ error: "Invalid or expired verification code" });
        return;
      }

      const { rows: clash } = await pool.query<QueryResultRow>(
        `SELECT id FROM users WHERE email = $1 AND ${PRODUCT_USER_SQL} LIMIT 1`,
        [pending.email],
      );
      if (clash.length > 0) {
        await pool.query(`UPDATE pending_signups SET used_at = NOW() WHERE id = $1`, [
          pending.id,
        ]);
        res.status(409).json({ error: "An account with this email already exists" });
        return;
      }

      const { rows: userResult } = await pool.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, full_name, email_verified_at, is_platform_admin)
         VALUES ($1, $2, $3, NOW(), FALSE)
         RETURNING id`,
        [pending.email, pending.password_hash, pending.full_name],
      );
      const userId = userResult[0].id;

      if (pending.organization_type && pending.organization_id) {
        const orgRole = ["owner", "admin", "manager", "viewer"].includes(
          String(pending.organization_role ?? ""),
        )
          ? pending.organization_role
          : "admin";
        await pool.query(
          `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
           VALUES ($1, $2, $3, $4)`,
          [pending.organization_type, pending.organization_id, userId, orgRole],
        );
      }

      // Guest Join Us drafts: attach businesses saved under this email before signup.
      try {
        await linkGuestBusinessesForVerifiedUser(userId, String(pending.email));
      } catch (linkErr) {
        console.error("guest business link on verify failed:", linkErr);
      }

      await pool.query(`UPDATE pending_signups SET used_at = NOW() WHERE id = $1`, [
        pending.id,
      ]);

      const sessionToken = generateSessionToken();
      await pool.query(
        `INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [userId, sessionToken, sessionExpiry()],
      );
      const user = await resolveAuthUser(sessionToken);
      res.json({
        success: true,
        emailVerified: true,
        token: sessionToken,
        user,
      });
      return;
    }

    // Legacy fallback: user already exists + email_verification_tokens.
    let legacy: QueryResultRow | undefined;
    if (token) {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT id, user_id, expires_at, used_at
         FROM email_verification_tokens
         WHERE token = $1
         LIMIT 1`,
        [token],
      );
      legacy = rows[0];
    } else if (isValidEmail(normalizedEmail) && /^\d{6}$/.test(code)) {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT evt.id, evt.user_id, evt.expires_at, evt.used_at
         FROM email_verification_tokens evt
         INNER JOIN users u ON u.id = evt.user_id
         WHERE u.email = $1
           AND ${PRODUCT_USER_U_SQL}
           AND evt.code = $2
         ORDER BY evt.created_at DESC
         LIMIT 1`,
        [normalizedEmail, code],
      );
      legacy = rows[0];
    }

    if (!legacy) {
      res.status(400).json({ error: "Invalid or expired verification code" });
      return;
    }
    if (legacy.used_at || new Date(legacy.expires_at) < new Date()) {
      res.status(400).json({ error: "Invalid or expired verification code" });
      return;
    }

    await pool.query(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [legacy.user_id],
    );
    await pool.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
      [legacy.id],
    );

    try {
      const { rows: userRows } = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`,
        [legacy.user_id],
      );
      const legacyEmail = userRows[0]?.email;
      if (legacyEmail) {
        await linkGuestBusinessesForVerifiedUser(Number(legacy.user_id), legacyEmail);
      }
    } catch (linkErr) {
      console.error("guest business link on legacy verify failed:", linkErr);
    }

    res.json({ success: true, emailVerified: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to verify email" });
  }
});

/**
 * POST /api/auth/resend-verification
 * body: { email: string }
 * response: { success: boolean, message: string }
 *
 * Resends for active pending_signups, or legacy unverified users.
 */
authRouter.post("/resend-verification", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(
      typeof req.body?.email === "string" ? req.body.email : "",
    );
    const generic = {
      success: true,
      message:
        "If an unverified account matches, a verification link and code have been sent.",
    };
    if (!isValidEmail(normalizedEmail)) {
      res.json(generic);
      return;
    }

    const { rows: pendingRows } = await pool.query<QueryResultRow>(
      `SELECT id, email, full_name
       FROM pending_signups
       WHERE LOWER(email) = $1 AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedEmail],
    );
    if (pendingRows.length > 0) {
      const token = crypto.randomBytes(32).toString("hex");
      const code = String(crypto.randomInt(100000, 1000000));
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query(
        `UPDATE pending_signups
         SET token = $1, code = $2, expires_at = $3
         WHERE id = $4`,
        [token, code, expires, pendingRows[0].id],
      );
      await sendPendingSignupEmail(
        String(pendingRows[0].email),
        pendingRows[0].full_name ?? null,
        token,
        code,
      );
      res.json(generic);
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, email, full_name, email_verified_at
       FROM users
       WHERE email = $1 AND ${PRODUCT_USER_SQL}
       LIMIT 1`,
      [normalizedEmail],
    );
    if (rows.length === 0 || rows[0].email_verified_at != null) {
      res.json(generic);
      return;
    }

    await createAndSendEmailVerification(
      Number(rows[0].id),
      String(rows[0].email),
      rows[0].full_name ?? null,
    );
    res.json(generic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to resend verification email" });
  }
});
