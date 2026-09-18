"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrganizationMembers = listOrganizationMembers;
exports.resolveOrgMemberSender = resolveOrgMemberSender;
exports.loadCampaignInviteSender = loadCampaignInviteSender;
exports.setCampaignInviteSenderUserId = setCampaignInviteSenderUserId;
exports.parseSenderUserId = parseSenderUserId;
exports.resolveUserSender = resolveUserSender;
const pool_1 = require("../db/pool");
function displayNameFromRow(row) {
    const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
    if (name)
        return name;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email || "ForkUp organizer";
}
function parsePositiveInt(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return Math.floor(n);
}
async function listOrganizationMembers(organizationType, organizationId, client) {
    const db = client ?? pool_1.pool;
    const { rows } = await db.query(`SELECT ou.user_id, ou.role, u.full_name, u.email
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
       LOWER(COALESCE(u.full_name, u.email)) ASC`, [organizationType, organizationId]);
    return rows.map((r) => ({
        userId: Number(r.user_id),
        fullName: displayNameFromRow(r),
        email: String(r.email).trim(),
        role: String(r.role),
    }));
}
async function resolveOrgMemberSender(organizationType, organizationId, senderUserId, client) {
    const db = client ?? pool_1.pool;
    const { rows } = await db.query(`SELECT ou.user_id, ou.role, u.full_name, u.email
     FROM organization_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.organization_type = $1
       AND ou.organization_id = $2
       AND ou.user_id = $3
     LIMIT 1`, [organizationType, organizationId, senderUserId]);
    const row = rows[0];
    if (!row)
        return null;
    const email = String(row.email).trim();
    if (!email.includes("@"))
        return null;
    return {
        userId: Number(row.user_id),
        fromName: displayNameFromRow(row),
        replyTo: email,
    };
}
async function loadCampaignInviteSender(campaignId, client) {
    const db = client ?? pool_1.pool;
    const { rows } = await db.query(`SELECT c.invite_sender_user_id AS user_id, u.full_name, u.email, 'owner'::text AS role
     FROM campaigns c
     JOIN users u ON u.id = c.invite_sender_user_id
     WHERE c.id = $1
       AND c.invite_sender_user_id IS NOT NULL
     LIMIT 1`, [campaignId]);
    const row = rows[0];
    if (!row)
        return null;
    const email = String(row.email).trim();
    if (!email.includes("@"))
        return null;
    return {
        userId: Number(row.user_id),
        fromName: displayNameFromRow(row),
        replyTo: email,
    };
}
async function setCampaignInviteSenderUserId(campaignId, senderUserId, client) {
    const db = client ?? pool_1.pool;
    await db.query(`UPDATE campaigns
     SET invite_sender_user_id = $1, updated_at = NOW()
     WHERE id = $2`, [senderUserId, campaignId]);
}
function parseSenderUserId(value) {
    return parsePositiveInt(value);
}
async function resolveUserSender(userId, client) {
    const db = client ?? pool_1.pool;
    const { rows } = await db.query(`SELECT id, full_name, email FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const row = rows[0];
    if (!row)
        return null;
    const email = String(row.email).trim();
    if (!email.includes("@"))
        return null;
    return {
        userId: Number(row.id),
        fromName: displayNameFromRow(row),
        replyTo: email,
    };
}
//# sourceMappingURL=invite-sender.js.map