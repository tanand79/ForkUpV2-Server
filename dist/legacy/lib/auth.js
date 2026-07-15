"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.generateSessionToken = generateSessionToken;
exports.sessionExpiry = sessionExpiry;
exports.resolveAuthUser = resolveAuthUser;
exports.bearerToken = bearerToken;
const crypto_1 = __importDefault(require("crypto"));
const util_1 = require("util");
const pool_1 = require("../db/pool");
const scrypt = (0, util_1.promisify)(crypto_1.default.scrypt);
async function hashPassword(password) {
    const salt = crypto_1.default.randomBytes(16).toString("hex");
    const derived = (await scrypt(password, salt, 64));
    return `${salt}:${derived.toString("hex")}`;
}
async function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash)
        return false;
    const derived = (await scrypt(password, salt, 64));
    const hashBuf = Buffer.from(hash, "hex");
    if (hashBuf.length !== derived.length)
        return false;
    return crypto_1.default.timingSafeEqual(hashBuf, derived);
}
function generateSessionToken() {
    return crypto_1.default.randomBytes(32).toString("hex");
}
const SESSION_DAYS = 30;
function sessionExpiry() {
    const d = new Date();
    d.setDate(d.getDate() + SESSION_DAYS);
    return d;
}
async function resolveAuthUser(token) {
    if (!token?.trim())
        return null;
    const { rows: sessions } = await pool_1.pool.query(`SELECT s.user_id, s.expires_at, u.email, u.full_name
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`, [token.trim()]);
    if (sessions.length === 0)
        return null;
    const row = sessions[0];
    if (new Date(row.expires_at) < new Date())
        return null;
    const userId = Number(row.user_id);
    const { rows: orgs } = await pool_1.pool.query(`SELECT organization_type, organization_id, role
     FROM organization_users WHERE user_id = $1`, [userId]);
    return {
        id: userId,
        email: row.email,
        fullName: row.full_name,
        organizations: orgs.map((o) => ({
            organizationType: o.organization_type,
            organizationId: Number(o.organization_id),
            role: o.role,
        })),
    };
}
function bearerToken(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return undefined;
    return header.slice(7).trim();
}
//# sourceMappingURL=auth.js.map