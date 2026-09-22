/**
 * Invite / email sender person helpers.
 *
 * Purpose: List organization members (NPO or business) and resolve From display
 * name + Reply-To for outbound mail. SMTP From address stays Super Admin
 * smtp_from; callers pass fromName/replyTo into sendEmail.
 * Optional campaigns.invite_from_name overrides From display name (editable).
 *
 * Inputs: organization type/id, optional senderUserId, campaign id, inviteFromName.
 * Outputs: member list; { fromName, replyTo }; campaign sender / from-name updates.
 */
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";

export type OrganizationType = "nonprofit" | "business";

export type OrgMemberPerson = {
  userId: number;
  fullName: string;
  email: string;
  role: string;
};

export type InviteSenderHeaders = {
  fromName: string;
  replyTo: string;
  userId: number;
};

type MemberRow = QueryResultRow & {
  user_id: number;
  full_name: string | null;
  email: string;
  role: string;
};

function displayNameFromRow(row: { full_name: string | null; email: string }): string {
  const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
  if (name) return name;
  const email = typeof row.email === "string" ? row.email.trim() : "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email || "ForkUp organizer";
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Parses optional body.inviteFromName (display name only, not email).
 * Inputs: raw body field. Outputs: trimmed string ≤255 or null.
 */
export function parseInviteFromName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 255);
  return trimmed || null;
}

/** Lists active organization_users joined to users for sender dropdowns. */
export async function listOrganizationMembers(
  organizationType: OrganizationType,
  organizationId: number,
  client?: PoolClient,
): Promise<OrgMemberPerson[]> {
  const db = client ?? pool;
  const { rows } = await db.query<MemberRow>(
    `SELECT ou.user_id, ou.role, u.full_name, u.email
     FROM organization_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.organization_type = $1
       AND ou.organization_id = $2
     ORDER BY
       CASE ou.role
         WHEN 'owner' THEN 0
         WHEN 'admin' THEN 1
         WHEN 'manager' THEN 2
         ELSE 3
       END,
       LOWER(COALESCE(u.full_name, u.email)) ASC`,
    [organizationType, organizationId],
  );
  return rows.map((r) => ({
    userId: Number(r.user_id),
    fullName: displayNameFromRow(r),
    email: String(r.email).trim(),
    role: String(r.role),
  }));
}

/**
 * Resolves From/Reply-To for a member of the given org.
 * Returns null when the user is not a member or has no usable email.
 */
export async function resolveOrgMemberSender(
  organizationType: OrganizationType,
  organizationId: number,
  senderUserId: number,
  client?: PoolClient,
): Promise<InviteSenderHeaders | null> {
  const db = client ?? pool;
  const { rows } = await db.query<MemberRow>(
    `SELECT ou.user_id, ou.role, u.full_name, u.email
     FROM organization_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.organization_type = $1
       AND ou.organization_id = $2
       AND ou.user_id = $3
     LIMIT 1`,
    [organizationType, organizationId, senderUserId],
  );
  const row = rows[0];
  if (!row) return null;
  const email = String(row.email).trim();
  if (!email.includes("@")) return null;
  return {
    userId: Number(row.user_id),
    fromName: displayNameFromRow(row),
    replyTo: email,
  };
}

/**
 * Loads persisted campaign From / Reply-To for lifecycle + deferred invites.
 * From display name: invite_from_name (custom) → person name when sender set.
 * Reply-To: selected sender email when invite_sender_user_id is set.
 */
export async function loadCampaignInviteSender(
  campaignId: number,
  client?: PoolClient,
): Promise<InviteSenderHeaders | null> {
  const db = client ?? pool;
  const { rows } = await db.query<
    QueryResultRow & {
      invite_sender_user_id: number | null;
      invite_from_name: string | null;
      full_name: string | null;
      email: string | null;
    }
  >(
    `SELECT c.invite_sender_user_id, c.invite_from_name, u.full_name, u.email
     FROM campaigns c
     LEFT JOIN users u ON u.id = c.invite_sender_user_id
     WHERE c.id = $1
     LIMIT 1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) return null;

  const customFrom =
    typeof row.invite_from_name === "string" ? row.invite_from_name.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim() : "";
  const personFrom =
    row.invite_sender_user_id != null
      ? displayNameFromRow({ full_name: row.full_name, email: email || "" })
      : "";
  const fromName = customFrom || personFrom;
  if (!fromName && !email.includes("@")) return null;

  return {
    userId:
      row.invite_sender_user_id != null ? Number(row.invite_sender_user_id) : 0,
    fromName: fromName || "ForkUp organizer",
    replyTo: email.includes("@") ? email : "",
  };
}

/** Persists campaigns.invite_sender_user_id (nullable). */
export async function setCampaignInviteSenderUserId(
  campaignId: number,
  senderUserId: number | null,
  client?: PoolClient,
): Promise<void> {
  const db = client ?? pool;
  await db.query(
    `UPDATE campaigns
     SET invite_sender_user_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [senderUserId, campaignId],
  );
}

/** Persists campaigns.invite_from_name (nullable display name only). */
export async function setCampaignInviteFromName(
  campaignId: number,
  fromName: string | null,
  client?: PoolClient,
): Promise<void> {
  const db = client ?? pool;
  const value =
    typeof fromName === "string" && fromName.trim()
      ? fromName.trim().slice(0, 255)
      : null;
  await db.query(
    `UPDATE campaigns
     SET invite_from_name = $1, updated_at = NOW()
     WHERE id = $2`,
    [value, campaignId],
  );
}

/**
 * Parses optional body.inviteSenderUserId / senderUserId.
 * Inputs: raw body field. Outputs: positive int or null.
 */
export function parseSenderUserId(value: unknown): number | null {
  return parsePositiveInt(value);
}

/**
 * Resolves sender for a signed-in user (fundraiser path — not org-scoped).
 * Inputs: userId. Outputs: headers or null.
 */
export async function resolveUserSender(
  userId: number,
  client?: PoolClient,
): Promise<InviteSenderHeaders | null> {
  const db = client ?? pool;
  const { rows } = await db.query<{ id: number; full_name: string | null; email: string }>(
    `SELECT id, full_name, email FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const email = String(row.email).trim();
  if (!email.includes("@")) return null;
  return {
    userId: Number(row.id),
    fromName: displayNameFromRow(row),
    replyTo: email,
  };
}
