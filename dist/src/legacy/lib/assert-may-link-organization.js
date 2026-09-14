"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertUserMayLinkOrganization = assertUserMayLinkOrganization;
async function assertUserMayLinkOrganization(client, params) {
    const { userId, organizationType, organizationId } = params;
    if (!Number.isFinite(organizationId) || organizationId <= 0) {
        return { ok: false, status: 400, error: "organizationId is invalid" };
    }
    if (organizationType === "nonprofit") {
        const { rows } = await client.query(`SELECT id, claimed_by_user_id FROM nonprofits WHERE id = $1`, [organizationId]);
        if (rows.length === 0) {
            return { ok: false, status: 404, error: "Nonprofit not found" };
        }
        const claimedBy = rows[0].claimed_by_user_id != null
            ? Number(rows[0].claimed_by_user_id)
            : null;
        return evaluateClaimAndMembers(client, {
            userId,
            organizationType,
            organizationId,
            claimedBy,
        });
    }
    const { rows } = await client.query(`SELECT id, claimed_by_user_id FROM businesses WHERE id = $1`, [organizationId]);
    if (rows.length === 0) {
        return { ok: false, status: 404, error: "Business not found" };
    }
    const claimedBy = rows[0].claimed_by_user_id != null
        ? Number(rows[0].claimed_by_user_id)
        : null;
    return evaluateClaimAndMembers(client, {
        userId,
        organizationType,
        organizationId,
        claimedBy,
    });
}
async function evaluateClaimAndMembers(client, params) {
    const { userId, organizationType, organizationId, claimedBy } = params;
    const { rows: selfRows } = await client.query(`SELECT 1 AS ok FROM organization_users
     WHERE organization_type = $1 AND organization_id = $2 AND user_id = $3
     LIMIT 1`, [organizationType, organizationId, userId]);
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
    const { rows: otherRows } = await client.query(`SELECT 1 AS ok FROM organization_users
     WHERE organization_type = $1 AND organization_id = $2 AND user_id <> $3
     LIMIT 1`, [organizationType, organizationId, userId]);
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
    return { ok: true };
}
//# sourceMappingURL=assert-may-link-organization.js.map