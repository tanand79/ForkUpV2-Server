/**
 * Guest campaign claim helpers (Pass 2).
 *
 * Purpose: After guest launch, email a manage/claim link. Claiming attaches the
 * signed-in user to the campaign nonprofit without first-come org theft on launch.
 *
 * Inputs: campaign id, guest email, frontend base URL.
 * Outputs: token persistence + email send; claim attaches organization_users.
 */
import crypto from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { sendEmail, resolveFrontendBaseUrl } from "./mailer";
import { assertUserMayLinkOrganization } from "./assert-may-link-organization";

const CLAIM_TTL_DAYS = 14;

export function generateGuestClaimToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function guestClaimExpiryDate(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + CLAIM_TTL_DAYS);
  return d;
}

/**
 * Persist claim token on campaign and email the guest.
 * Inputs: campaignId, slug, campaignName, guestEmail.
 * Outputs: { token, emailSent }.
 */
export async function issueGuestCampaignClaim(input: {
  connection?: PoolClient;
  campaignId: number;
  slug: string;
  campaignName: string;
  guestEmail: string;
}): Promise<{ token: string; emailSent: boolean }> {
  const token = generateGuestClaimToken();
  const expiresAt = guestClaimExpiryDate();
  const email = input.guestEmail.trim().toLowerCase();
  const db = input.connection ?? pool;

  await db.query(
    `UPDATE campaigns SET
       guest_claim_email = $1,
       guest_claim_token = $2,
       guest_claim_expires_at = $3,
       guest_claim_claimed_at = NULL,
       updated_at = NOW()
     WHERE id = $4`,
    [email, token, expiresAt, input.campaignId],
  );

  const claimUrl = `${resolveFrontendBaseUrl()}/?step=guest-campaign-claim&token=${encodeURIComponent(token)}`;
  const publicUrl = `${resolveFrontendBaseUrl()}/campaign/${encodeURIComponent(input.slug)}`;

  const sent = await sendEmail({
    to: email,
    emailType: "guest_campaign_claim",
    relatedToken: token,
    senderParty: "platform",
    campaignId: input.campaignId,
    subject: `Manage your ForkUp campaign: ${input.campaignName}`,
    body: [
      `Your campaign "${input.campaignName}" is live on ForkUp.`,
      ``,
      `Public page: ${publicUrl}`,
      ``,
      `Claim / manage this campaign (works on any device):`,
      claimUrl,
      ``,
      `This link expires in ${CLAIM_TTL_DAYS} days. Do not forward it — anyone with the link can claim management.`,
    ].join("\n"),
  });

  return { token, emailSent: sent.status === "sent" || sent.status === "skipped" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type GuestClaimLookup = {
  campaignId: number;
  slug: string;
  campaignName: string;
  nonprofitId: number;
  guestEmail: string;
  expiresAt: Date;
  claimedAt: Date | null;
};

/**
 * Load a valid (or already-claimed) guest claim by token.
 */
export async function lookupGuestClaimToken(
  token: string,
): Promise<GuestClaimLookup | null> {
  const t = token.trim();
  if (!t) return null;
  const { rows } = await pool.query<{
    id: number;
    slug: string;
    campaign_name: string;
    nonprofit_id: number;
    guest_claim_email: string | null;
    guest_claim_expires_at: Date | null;
    guest_claim_claimed_at: Date | null;
  }>(
    `SELECT id, slug, campaign_name, nonprofit_id,
            guest_claim_email, guest_claim_expires_at, guest_claim_claimed_at
     FROM campaigns
     WHERE guest_claim_token = $1
     LIMIT 1`,
    [t],
  );
  const row = rows[0];
  if (!row?.guest_claim_email) return null;
  return {
    campaignId: Number(row.id),
    slug: String(row.slug),
    campaignName: String(row.campaign_name),
    nonprofitId: Number(row.nonprofit_id),
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
 * Attach authenticated user as nonprofit admin + campaign creator.
 * Inputs: userId, claim lookup. Outputs: { ok, error? }.
 */
export async function claimGuestCampaignForUser(
  userId: number,
  claim: GuestClaimLookup,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (claim.claimedAt) {
    return { ok: false, error: "This campaign was already claimed.", status: 409 };
  }
  if (claim.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "This claim link has expired.", status: 410 };
  }

  const mayLink = await assertUserMayLinkOrganization(pool, {
    userId,
    organizationType: "nonprofit",
    organizationId: claim.nonprofitId,
  });
  if (!mayLink.ok) {
    return {
      ok: false,
      error:
        mayLink.error ||
        "This nonprofit is already owned. Request access or use the fundraiser path.",
      status: mayLink.status || 403,
    };
  }

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('nonprofit', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
      [claim.nonprofitId, userId],
    );
    await connection.query(
      `UPDATE nonprofits SET
         claim_status = CASE
           WHEN claim_status IS NULL OR claim_status = 'unclaimed'
           THEN 'claimed' ELSE claim_status END,
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         updated_at = NOW()
       WHERE id = $2`,
      [userId, claim.nonprofitId],
    );
    await connection.query(
      `UPDATE campaigns SET
         created_by_user_id = COALESCE(created_by_user_id, $1),
         guest_claim_claimed_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`,
      [userId, claim.campaignId],
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
