/**
 * Guest business claim helpers.
 *
 * Purpose: After guest restaurant/local join, email a manage/claim link.
 * Claiming attaches the signed-in user to the business without letting a
 * second email overwrite the draft.
 *
 * Inputs: business id, name, slug, guest email, frontend base URL.
 * Outputs: token persistence + email send; claim attaches organization_users.
 */
import crypto from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { sendEmail, resolveFrontendBaseUrl } from "./mailer";
import { assertUserMayLinkOrganization } from "./assert-may-link-organization";
import { renderGuestClaimEmail } from "./guest-claim-email";

const CLAIM_TTL_DAYS = 14;

export function generateGuestBusinessClaimToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function guestBusinessClaimExpiryDate(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + CLAIM_TTL_DAYS);
  return d;
}

/**
 * Persist claim token on business and email the guest.
 * Inputs: businessId, slug, businessName, guestEmail.
 * Outputs: { token, emailSent }.
 */
export async function issueGuestBusinessClaim(input: {
  connection?: PoolClient;
  businessId: number;
  slug: string;
  businessName: string;
  guestEmail: string;
}): Promise<{ token: string; emailSent: boolean }> {
  const token = generateGuestBusinessClaimToken();
  const expiresAt = guestBusinessClaimExpiryDate();
  const email = input.guestEmail.trim().toLowerCase();
  const db = input.connection ?? pool;

  await db.query(
    `UPDATE businesses SET
       guest_claim_email = $1,
       guest_claim_token = $2,
       guest_claim_expires_at = $3,
       guest_claim_claimed_at = NULL,
       updated_at = NOW()
     WHERE id = $4`,
    [email, token, expiresAt, input.businessId],
  );

  const claimUrl = `${resolveFrontendBaseUrl()}/?step=guest-business-claim&token=${encodeURIComponent(token)}`;
  const rendered = renderGuestClaimEmail({
    kind: "business",
    entityName: input.businessName,
    claimUrl,
    expiresInDays: CLAIM_TTL_DAYS,
  });

  const sent = await sendEmail({
    to: email,
    emailType: "guest_business_claim",
    relatedToken: token,
    senderParty: "platform",
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
  });

  return { token, emailSent: sent.status === "sent" || sent.status === "skipped" };
}

export type GuestBusinessClaimLookup = {
  businessId: number;
  slug: string;
  businessName: string;
  guestEmail: string;
  expiresAt: Date;
  claimedAt: Date | null;
};

/**
 * Load a valid (or already-claimed) guest business claim by token.
 */
export async function lookupGuestBusinessClaimToken(
  token: string,
): Promise<GuestBusinessClaimLookup | null> {
  const t = token.trim();
  if (!t) return null;
  const { rows } = await pool.query<{
    id: number;
    slug: string;
    business_name: string;
    guest_claim_email: string | null;
    guest_claim_expires_at: Date | null;
    guest_claim_claimed_at: Date | null;
  }>(
    `SELECT id, slug, business_name,
            guest_claim_email, guest_claim_expires_at, guest_claim_claimed_at
     FROM businesses
     WHERE guest_claim_token = $1
     LIMIT 1`,
    [t],
  );
  const row = rows[0];
  if (!row?.guest_claim_email) return null;
  return {
    businessId: Number(row.id),
    slug: String(row.slug),
    businessName: String(row.business_name),
    guestEmail: String(row.guest_claim_email).trim().toLowerCase(),
    expiresAt: row.guest_claim_expires_at
      ? new Date(row.guest_claim_expires_at)
      : new Date(0),
    claimedAt: row.guest_claim_claimed_at
      ? new Date(row.guest_claim_claimed_at)
      : null,
  };
}

/**
 * Attach authenticated user as business admin.
 * Inputs: userId, claim lookup. Outputs: { ok, error? }.
 */
export async function claimGuestBusinessForUser(
  userId: number,
  claim: GuestBusinessClaimLookup,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (claim.claimedAt) {
    return { ok: false, error: "This business was already claimed.", status: 409 };
  }
  if (claim.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "This claim link has expired.", status: 410 };
  }

  const mayLink = await assertUserMayLinkOrganization(pool, {
    userId,
    organizationType: "business",
    organizationId: claim.businessId,
  });
  if (!mayLink.ok) {
    return {
      ok: false,
      error:
        mayLink.error ||
        "This business is already owned. Request access or use a different profile.",
      status: mayLink.status || 403,
    };
  }

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('business', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
      [claim.businessId, userId],
    );
    await connection.query(
      `UPDATE businesses SET
         claim_status = CASE
           WHEN claim_status IS NULL OR claim_status IN ('unclaimed', 'needs_review')
           THEN 'claimed' ELSE claim_status END,
         profile_status = COALESCE(profile_status, 'claimed'),
         business_status = COALESCE(business_status, 'active'),
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         claim_date = COALESCE(claim_date, NOW()),
         guest_claim_claimed_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`,
      [userId, claim.businessId],
    );
    await connection.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }
}
