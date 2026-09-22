"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseInviteFromName = parseInviteFromName;
exports.listOrganizationMembers = listOrganizationMembers;
exports.resolveOrgMemberSender = resolveOrgMemberSender;
exports.loadCampaignInviteSender = loadCampaignInviteSender;
exports.setCampaignInviteSenderUserId = setCampaignInviteSenderUserId;
exports.setCampaignInviteFromName = setCampaignInviteFromName;
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
function parseInviteFromName(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim().slice(0, 255);
    return trimmed || null;
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
    const { rows } = await db.query(`SELECT c.invite_sender_user_id, c.invite_from_name, u.full_name, u.email
     FROM campaigns c
     LEFT JOIN users u ON u.id = c.invite_sender_user_id
     WHERE c.id = $1
     LIMIT 1`, [campaignId]);
    const row = rows[0];
    if (!row)
        return null;
    const customFrom = typeof row.invite_from_name === "string" ? row.invite_from_name.trim() : "";
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const personFrom = row.invite_sender_user_id != null
        ? displayNameFromRow({ full_name: row.full_name, email: email || "" })
        : "";
    const fromName = customFrom || personFrom;
    if (!fromName && !email.includes("@"))
        return null;
    return {
        userId: row.invite_sender_user_id != null ? Number(row.invite_sender_user_id) : 0,
        fromName: fromName || "ForkUp organizer",
        replyTo: email.includes("@") ? email : "",
    };
}
async function setCampaignInviteSenderUserId(campaignId, senderUserId, client) {
    const db = client ?? pool_1.pool;
    await db.query(`UPDATE campaigns
     SET invite_sender_user_id = $1, updated_at = NOW()
     WHERE id = $2`, [senderUserId, campaignId]);
}
async function setCampaignInviteFromName(campaignId, fromName, client) {
    const db = client ?? pool_1.pool;
    const value = typeof fromName === "string" && fromName.trim()
        ? fromName.trim().slice(0, 255)
        : null;
    await db.query(`UPDATE campaigns
     SET invite_from_name = $1, updated_at = NOW()
     WHERE id = $2`, [value, campaignId]);
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