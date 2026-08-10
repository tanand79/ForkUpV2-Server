import { Router } from "express";
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
