/**
 * Link guest business drafts to a newly verified user by matching email.
 *
 * Purpose: After Create account (optional) → verify, attach businesses that were
 * saved as guest drafts (claimed_by_user_id null) under the same contact email.
 *
 * Inputs: userId, verified email.
 * Outputs: list of linked business ids (may be empty).
 */
import { pool } from "../db/pool";

/**
 * Attach matching guest/unclaimed business rows to this user.
 * Inputs: userId, email (normalized preferred).
 * Outputs: business ids linked in this call.
 */
export async function linkGuestBusinessesForVerifiedUser(
  userId: number,
  email: string,
): Promise<number[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@") || !Number.isFinite(userId) || userId <= 0) {
    return [];
  }

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id
     FROM businesses
     WHERE (
             LOWER(TRIM(contact_email)) = $1
          OR LOWER(TRIM(COALESCE(guest_claim_email, ''))) = $1
          )
       AND (claimed_by_user_id IS NULL OR claimed_by_user_id = $2)
     ORDER BY id ASC`,
    [normalized, userId],
  );

  const linked: number[] = [];
  for (const row of rows) {
    const businessId = Number(row.id);
    if (!Number.isFinite(businessId) || businessId <= 0) continue;

    await pool.query(
      `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('business', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
      [businessId, userId],
    );

    await pool.query(
      `UPDATE businesses SET
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         claim_status = CASE
           WHEN claim_status IS NULL OR claim_status IN ('unclaimed', 'needs_review')
           THEN 'claimed' ELSE claim_status END,
         profile_status = COALESCE(profile_status, 'claimed'),
         business_status = CASE
           WHEN business_status IN ('preloaded', 'invited') THEN 'active'
           ELSE business_status END,
         claim_date = COALESCE(claim_date, NOW()),
         guest_claim_claimed_at = COALESCE(guest_claim_claimed_at, NOW()),
         updated_at = NOW()
       WHERE id = $2`,
      [userId, businessId],
    );

    linked.push(businessId);
  }

  return linked;
}
