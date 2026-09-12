"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateGuestClaimToken = generateGuestClaimToken;
exports.guestClaimExpiryDate = guestClaimExpiryDate;
exports.issueGuestCampaignClaim = issueGuestCampaignClaim;
exports.lookupGuestClaimToken = lookupGuestClaimToken;
exports.claimGuestCampaignForUser = claimGuestCampaignForUser;
const crypto_1 = __importDefault(require("crypto"));
const pool_1 = require("../db/pool");
const mailer_1 = require("./mailer");
const assert_may_link_organization_1 = require("./assert-may-link-organization");
const CLAIM_TTL_DAYS = 14;
function generateGuestClaimToken() {
    return crypto_1.default.randomBytes(32).toString("hex");
}
function guestClaimExpiryDate(from = new Date()) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + CLAIM_TTL_DAYS);
    return d;
}
async function issueGuestCampaignClaim(input) {
    const token = generateGuestClaimToken();
    const expiresAt = guestClaimExpiryDate();
    const email = input.guestEmail.trim().toLowerCase();
    const db = input.connection ?? pool_1.pool;
    await db.query(`UPDATE campaigns SET
       guest_claim_email = $1,
       guest_claim_token = $2,
       guest_claim_expires_at = $3,
       guest_claim_claimed_at = NULL,
       updated_at = NOW()
     WHERE id = $4`, [email, token, expiresAt, input.campaignId]);
    const claimUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=guest-campaign-claim&token=${encodeURIComponent(token)}`;
    const publicUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/campaign/${encodeURIComponent(input.slug)}`;
    const sent = await (0, mailer_1.sendEmail)({
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
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
async function lookupGuestClaimToken(token) {
    const t = token.trim();
    if (!t)
        return null;
    const { rows } = await pool_1.pool.query(`SELECT id, slug, campaign_name, nonprofit_id,
            guest_claim_email, guest_claim_expires_at, guest_claim_claimed_at
     FROM campaigns
     WHERE guest_claim_token = $1
     LIMIT 1`, [t]);
    const row = rows[0];
    if (!row?.guest_claim_email)
        return null;
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
async function claimGuestCampaignForUser(userId, claim) {
    if (claim.claimedAt) {
        return { ok: false, error: "This campaign was already claimed.", status: 409 };
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
                "This nonprofit is already owned. Request access or use the fundraiser path.",
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
           WHEN claim_status IS NULL OR claim_status = 'unclaimed'
           THEN 'claimed' ELSE claim_status END,
         claimed_by_user_id = COALESCE(claimed_by_user_id, $1),
         updated_at = NOW()
       WHERE id = $2`, [userId, claim.nonprofitId]);
        await connection.query(`UPDATE campaigns SET
         created_by_user_id = COALESCE(created_by_user_id, $1),
         guest_claim_claimed_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`, [userId, claim.campaignId]);
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
//# sourceMappingURL=guest-campaign-claim.js.map