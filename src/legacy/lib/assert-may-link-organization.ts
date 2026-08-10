/**
 * Organization link authorization guard.
 *
 * Purpose: Prevent attaching a user to a nonprofit/business they do not own
 * via `/api/auth/link-organization` or register-time `organizationId`.
 *
 * Inputs:
 * - client — pg Pool or PoolClient
 * - userId — authenticated (or about-to-create) user id
 * - organizationType — 'nonprofit' | 'business'
 * - organizationId — target org primary key
 *
 * Outputs:
 * - { ok: true } when the link is allowed
 * - { ok: false, status, error } when the link must be rejected
 *
 * Rules (allow when any apply):
 * - Org does not exist → 404
 * - User is already an organization_users member → allow (idempotent)
 * - Org has no claimed_by_user_id and no other members → allow (guest / unclaimed)
 * - Org claimed_by_user_id === userId → allow
 *
 * Deny when:
 * - claimed_by_user_id is a different user, or
 * - other users already have membership on this org
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";

type Db = Pool | PoolClient;

export type LinkOrgGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export async function assertUserMayLinkOrganization(
  client: Db,
  params: {
    userId: number;
    organizationType: "nonprofit" | "business";
    organizationId: number;
  },
): Promise<LinkOrgGuardResult> {
  const { userId, organizationType, organizationId } = params;

  if (!Number.isFinite(organizationId) || organizationId <= 0) {
    return { ok: false, status: 400, error: "organizationId is invalid" };
  }

  if (organizationType === "nonprofit") {
    const { rows } = await client.query<QueryResultRow>(
      `SELECT id, claimed_by_user_id FROM nonprofits WHERE id = $1`,
      [organizationId],
    );
    if (rows.length === 0) {
      return { ok: false, status: 404, error: "Nonprofit not found" };
    }
    const claimedBy =
      rows[0].claimed_by_user_id != null
        ? Number(rows[0].claimed_by_user_id)
        : null;
    return evaluateClaimAndMembers(client, {
      userId,
      organizationType,
      organizationId,
      claimedBy,
    });
  }

  const { rows } = await client.query<QueryResultRow>(
    `SELECT id, claimed_by_user_id FROM businesses WHERE id = $1`,
    [organizationId],
  );
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "Business not found" };
  }
  const claimedBy =
    rows[0].claimed_by_user_id != null
      ? Number(rows[0].claimed_by_user_id)
      : null;
  return evaluateClaimAndMembers(client, {
    userId,
    organizationType,
    organizationId,
    claimedBy,
  });
}

async function evaluateClaimAndMembers(
  client: Db,
  params: {
    userId: number;
    organizationType: "nonprofit" | "business";
    organizationId: number;
    claimedBy: number | null;
  },
): Promise<LinkOrgGuardResult> {
  const { userId, organizationType, organizationId, claimedBy } = params;

  const { rows: selfRows } = await client.query<QueryResultRow>(
    `SELECT 1 AS ok FROM organization_users
     WHERE organization_type = $1 AND organization_id = $2 AND user_id = $3
     LIMIT 1`,
    [organizationType, organizationId, userId],
  );
  if (selfRows.length > 0) {
    return { ok: true };
  }

  if (claimedBy != null && claimedBy !== userId) {
    return {
      ok: false,
      status: 403,
      error: "This organization is already claimed by another account",
    };
  }

  const { rows: otherRows } = await client.query<QueryResultRow>(
    `SELECT 1 AS ok FROM organization_users
     WHERE organization_type = $1 AND organization_id = $2 AND user_id <> $3
     LIMIT 1`,
    [organizationType, organizationId, userId],
  );
  if (otherRows.length > 0) {
    return {
      ok: false,
      status: 403,
      error: "This organization is already linked to another account",
    };
  }

  if (claimedBy != null && claimedBy === userId) {
    return { ok: true };
  }

  // Unclaimed / no other members — guest claim or first link.
  return { ok: true };
}
