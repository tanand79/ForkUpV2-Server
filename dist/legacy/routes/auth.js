"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const pool_1 = require("../db/pool");
const auth_profiles_1 = require("../lib/auth-profiles");
const assert_may_link_organization_1 = require("../lib/assert-may-link-organization");
exports.authRouter = (0, express_1.Router)();
function normalizeEmail(raw) {
    return raw.trim().toLowerCase();
}
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}
exports.authRouter.get("/check-email", async (req, res) => {
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
        const { rows: existing } = await pool_1.pool.query("SELECT id FROM users WHERE email = $1", [email]);
        res.json({
            valid: true,
            available: existing.length === 0,
            message: existing.length > 0
                ? "An account with this email already exists. Please sign in instead."
                : "Email is available",
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to check email" });
    }
});
exports.authRouter.get("/context", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        const nonprofitProfiles = await (0, auth_profiles_1.loadUserNonprofitProfiles)(user);
        const businessProfiles = await (0, auth_profiles_1.loadUserBusinessProfiles)(user);
        res.json({
            user,
            nonprofitProfiles,
            businessProfiles,
            nonprofitProfile: nonprofitProfiles[0] ?? null,
            businessProfile: businessProfiles[0] ?? null,
        });
    }
    catch (err) {
        console.error("GET /auth/context failed:", err);
        const message = err instanceof Error ? err.message : "Failed to load session context";
        res.status(500).json({ error: message });
    }
});
exports.authRouter.post("/register", async (req, res) => {
    try {
        const { email, password, fullName, organizationType, organizationId, role } = req.body;
        const normalizedEmail = normalizeEmail(email ?? "");
        if (!isValidEmail(normalizedEmail)) {
            res.status(400).json({ error: "Enter a valid email address" });
            return;
        }
        if (!password || password.length < 8) {
            res.status(400).json({ error: "Password must be at least 8 characters" });
            return;
        }
        const { rows: existing } = await pool_1.pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
        if (existing.length > 0) {
            res.status(409).json({ error: "An account with this email already exists" });
            return;
        }
        if (organizationType && organizationId) {
            const preLink = await (0, assert_may_link_organization_1.assertUserMayLinkOrganization)(pool_1.pool, {
                userId: -1,
                organizationType,
                organizationId: Number(organizationId),
            });
            if (!preLink.ok) {
                res.status(preLink.status).json({ error: preLink.error });
                return;
            }
        }
        const passwordHash = await (0, auth_1.hashPassword)(password);
        const { rows: userResult } = await pool_1.pool.query("INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id", [normalizedEmail, passwordHash, fullName?.trim() ?? null]);
        const userId = userResult[0].id;
        if (organizationType && organizationId) {
            const orgRole = ["owner", "admin", "manager", "viewer"].includes(role ?? "")
                ? role
                : "admin";
            await pool_1.pool.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
         VALUES ($1, $2, $3, $4)`, [organizationType, organizationId, userId, orgRole]);
        }
        const token = (0, auth_1.generateSessionToken)();
        await pool_1.pool.query("INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)", [userId, token, (0, auth_1.sessionExpiry)()]);
        const user = await (0, auth_1.resolveAuthUser)(token);
        res.status(201).json({ token, user });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Registration failed" });
    }
});
exports.authRouter.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = normalizeEmail(email ?? "");
        if (!isValidEmail(normalizedEmail) || !password) {
            res.status(400).json({ error: "Enter a valid email and password" });
            return;
        }
        const { rows: rows } = await pool_1.pool.query("SELECT id, password_hash FROM users WHERE email = $1", [normalizedEmail]);
        if (rows.length === 0) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const valid = await (0, auth_1.verifyPassword)(password, String(rows[0].password_hash ?? ""));
        if (!valid) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const token = (0, auth_1.generateSessionToken)();
        await pool_1.pool.query("INSERT INTO auth_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)", [rows[0].id, token, (0, auth_1.sessionExpiry)()]);
        const user = await (0, auth_1.resolveAuthUser)(token);
        res.json({ token, user });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Login failed" });
    }
});
exports.authRouter.post("/logout", async (req, res) => {
    try {
        const token = (0, auth_1.bearerToken)(req);
        if (token) {
            await pool_1.pool.query("DELETE FROM auth_sessions WHERE token = $1", [token]);
        }
        res.json({ success: true });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Logout failed" });
    }
});
exports.authRouter.get("/me", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        res.json(user);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch session" });
    }
});
exports.authRouter.post("/link-organization", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        const { organizationType, organizationId, role } = req.body;
        if (!organizationType || !organizationId) {
            res.status(400).json({ error: "organizationType and organizationId are required" });
            return;
        }
        const mayLink = await (0, assert_may_link_organization_1.assertUserMayLinkOrganization)(pool_1.pool, {
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
        await pool_1.pool.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_type, organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`, [organizationType, organizationId, user.id, orgRole]);
        const updated = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        res.json(updated);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to link organization" });
    }
});
//# sourceMappingURL=auth.js.map