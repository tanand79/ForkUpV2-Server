/**
 * Link guest nonprofit drafts to a newly verified user by matching email.
 *
 * Purpose: After Create account (optional) → verify, attach nonprofits that were
 * saved as guest drafts under the same contact / guest_claim email.
 *
 * Inputs: userId, verified email.
 * Outputs: list of linked nonprofit ids (may be empty).
 */
import { pool } from "../db/pool";

/**
 * Attach matching guest/unclaimed nonprofit rows to this user.
 * Inputs: userId, email (normalized preferred).
 * Outputs: nonprofit ids linked in this call.
 */
export async function linkGuestNonprofitsForVerifiedUser(
  userId: number,
  email: string,
): Promise<number[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@") || !Number.isFinite(userId) || userId <= 0) {
    return [];
  }

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id
     FROM nonprofits
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
    const nonprofitId = Number(row.id);
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) continue;

    await pool.query(
      `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('nonprofit', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
      [nonprofitId, userId],
    );

    await pool.query(
      `UPDATE nonprofits SET
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         claim_status = CASE
           WHEN claim_status IS NULL OR claim_status IN ('unclaimed', 'needs_review')
           THEN 'claimed' ELSE claim_status END,
         profile_status = COALESCE(profile_status, 'claimed'),
         claim_date = COALESCE(claim_date, NOW()),
         guest_claim_claimed_at = COALESCE(guest_claim_claimed_at, NOW()),
         updated_at = NOW()
       WHERE id = $2`,
      [userId, nonprofitId],
    );

    linked.push(nonprofitId);
  }

  return linked;
}
