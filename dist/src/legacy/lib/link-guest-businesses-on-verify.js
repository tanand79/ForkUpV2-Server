"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.linkGuestBusinessesForVerifiedUser = linkGuestBusinessesForVerifiedUser;
const pool_1 = require("../db/pool");
async function linkGuestBusinessesForVerifiedUser(userId, email) {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@") || !Number.isFinite(userId) || userId <= 0) {
        return [];
    }
    const { rows } = await pool_1.pool.query(`SELECT id
     FROM businesses
     WHERE (
             LOWER(TRIM(contact_email)) = $1
          OR LOWER(TRIM(COALESCE(guest_claim_email, ''))) = $1
          )
       AND (claimed_by_user_id IS NULL OR claimed_by_user_id = $2)
     ORDER BY id ASC`, [normalized, userId]);
    const linked = [];
    for (const row of rows) {
        const businessId = Number(row.id);
        if (!Number.isFinite(businessId) || businessId <= 0)
            continue;
        await pool_1.pool.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('business', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`, [businessId, userId]);
        await pool_1.pool.query(`UPDATE businesses SET
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
       WHERE id = $2`, [userId, businessId]);
        linked.push(businessId);
    }
    return linked;
}
//# sourceMappingURL=link-guest-businesses-on-verify.js.map