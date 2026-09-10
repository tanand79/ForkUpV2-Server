import crypto from "crypto";
import { promisify } from "util";
import type { Request } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const hashBuf = Buffer.from(hash, "hex");
  if (hashBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(hashBuf, derived);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_DAYS = 30;

export function sessionExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d;
}

export type AuthUser = {
  id: number;
  email: string;
  fullName: string | null;
  username: string | null;
  isPlatformAdmin: boolean;
  /** True when users.email_verified_at is set (existing accounts backfilled). */
  emailVerified: boolean;
  organizations: {
    organizationType: "nonprofit" | "business";
    organizationId: number;
    role: string;
  }[];
};

export async function resolveAuthUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token?.trim()) return null;

  const { rows: sessions } = await pool.query<QueryResultRow>(
    `SELECT s.user_id, s.expires_at, u.email, u.full_name, u.username,
            u.email_verified_at,
            COALESCE(u.is_platform_admin, FALSE) AS is_platform_admin
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token.trim()],
  );
  if (sessions.length === 0) return null;

  const row = sessions[0];
  if (new Date(row.expires_at) < new Date()) return null;

  const userId = Number(row.user_id);
  const { rows: orgs } = await pool.query<QueryResultRow>(
    `SELECT organization_type, organization_id, role
     FROM organization_users WHERE user_id = $1`,
    [userId],
  );

  return {
    id: userId,
    email: row.email,
    fullName: row.full_name,
    username: row.username ?? null,
    isPlatformAdmin: Boolean(row.is_platform_admin),
    emailVerified: row.email_verified_at != null,
    organizations: orgs.map((o) => ({
      organizationType: o.organization_type,
      organizationId: Number(o.organization_id),
      role: o.role,
    })),
  };
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim();
}
