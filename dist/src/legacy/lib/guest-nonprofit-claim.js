"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateGuestNonprofitClaimToken = generateGuestNonprofitClaimToken;
exports.guestNonprofitClaimExpiryDate = guestNonprofitClaimExpiryDate;
exports.issueGuestNonprofitClaim = issueGuestNonprofitClaim;
exports.lookupGuestNonprofitClaimToken = lookupGuestNonprofitClaimToken;
exports.claimGuestNonprofitForUser = claimGuestNonprofitForUser;
const crypto_1 = __importDefault(require("crypto"));
const pool_1 = require("../db/pool");
const mailer_1 = require("./mailer");
const assert_may_link_organization_1 = require("./assert-may-link-organization");
const guest_claim_email_1 = require("./guest-claim-email");
const CLAIM_TTL_DAYS = 14;
function generateGuestNonprofitClaimToken() {
    return crypto_1.default.randomBytes(32).toString("hex");
}
function guestNonprofitClaimExpiryDate(from = new Date()) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + CLAIM_TTL_DAYS);
    return d;
}
async function issueGuestNonprofitClaim(input) {
    const token = generateGuestNonprofitClaimToken();
    const expiresAt = guestNonprofitClaimExpiryDate();
    const email = input.guestEmail.trim().toLowerCase();
    const db = input.connection ?? pool_1.pool;
    await db.query(`UPDATE nonprofits SET
       guest_claim_email = $1,
       guest_claim_token = $2,
       guest_claim_expires_at = $3,
       guest_claim_claimed_at = NULL,
       updated_at = NOW()
     WHERE id = $4`, [email, token, expiresAt, input.nonprofitId]);
    const claimUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=guest-nonprofit-claim&token=${encodeURIComponent(token)}`;
    const rendered = (0, guest_claim_email_1.renderGuestClaimEmail)({
        kind: "nonprofit",
        entityName: input.organizationName,
        claimUrl,
        expiresInDays: CLAIM_TTL_DAYS,
    });
    const sent = await (0, mailer_1.sendEmail)({
        to: email,
        emailType: "guest_nonprofit_claim",
        relatedToken: token,
        senderParty: "platform",
        subject: rendered.subject,
        body: rendered.body,
        html: rendered.html,
    });
    return { token, emailSent: sent.status === "sent" || sent.status === "skipped" };
}
async function lookupGuestNonprofitClaimToken(token) {
    const t = token.trim();
    if (!t)
        return null;
    const { rows } = await pool_1.pool.query(`SELECT id, slug, organization_name,
            guest_claim_email, guest_claim_expires_at, guest_claim_claimed_at
     FROM nonprofits
     WHERE guest_claim_token = $1
     LIMIT 1`, [t]);
    const row = rows[0];
    if (!row?.guest_claim_email)
        return null;
    return {
        nonprofitId: Number(row.id),
        slug: String(row.slug),
        organizationName: String(row.organization_name),
        guestEmail: String(row.guest_claim_email).trim().toLowerCase(),
        expiresAt: row.guest_claim_expires_at
            ? new Date(row.guest_claim_expires_at)
            : new Date(0),
        claimedAt: row.guest_claim_claimed_at
            ? new Date(row.guest_claim_claimed_at)
            : null,
    };
}
async function claimGuestNonprofitForUser(userId, claim) {
    if (claim.claimedAt) {
        return { ok: false, error: "This organization was already claimed.", status: 409 };
    }
    if (claim.expiresAt.getTime() < Date.now()) {
        return { ok: false, error: "This claim link has expired.", status: 410 };
    }
    const mayLink = await (0, assert_may_link_organization_1.assertUserMayLinkOrganization)(pool_1.pool, {
        userId,
        organizationType: "nonprofit",
        organizationId: claim.nonprofitId,
    });
    if (!mayLink.ok) {
        return {
            ok: false,
            error: mayLink.error ||
                "This organization is already owned. Request access or use a different profile.",
            status: mayLink.status || 403,
        };
    }
    const connection = await pool_1.pool.connect();
    try {
        await connection.query("BEGIN");
        await connection.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
       VALUES ('nonprofit', $1, $2, 'admin')
       ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`, [claim.nonprofitId, userId]);
        await connection.query(`UPDATE nonprofits SET
         claim_status = CASE
           WHEN claim_status IS NULL OR claim_status IN ('unclaimed', 'needs_review')
           THEN 'claimed' ELSE claim_status END,
         profile_status = COALESCE(profile_status, 'claimed'),
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         claim_date = COALESCE(claim_date, NOW()),
         guest_claim_claimed_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`, [userId, claim.nonprofitId]);
        await connection.query("COMMIT");
        return { ok: true };
    }
    catch (err) {
        await connection.query("ROLLBACK");
        throw err;
    }
    finally {
        connection.release();
    }
}
//# sourceMappingURL=guest-nonprofit-claim.js.map