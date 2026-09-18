"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userBelongsToBusiness = userBelongsToBusiness;
exports.userMayManageCampaignNonprofit = userMayManageCampaignNonprofit;
exports.createPartnerJoinRequest = createPartnerJoinRequest;
exports.listPartnerJoinRequestsForCampaign = listPartnerJoinRequestsForCampaign;
exports.listMyPartnerJoinRequests = listMyPartnerJoinRequests;
exports.acceptPartnerJoinRequest = acceptPartnerJoinRequest;
exports.declinePartnerJoinRequest = declinePartnerJoinRequest;
const pool_1 = require("../db/pool");
const business_invite_timing_1 = require("./business-invite-timing");
const business_invitation_record_1 = require("./business-invitation-record");
const business_lifecycle_emails_1 = require("./business-lifecycle-emails");
const date_only_1 = require("./date-only");
const invitations_1 = require("./invitations");
const methods_1 = require("./methods");
const mailer_1 = require("./mailer");
const JOINABLE_METHOD_TYPES = [
    "dine_and_donate",
    "shop_and_donate",
    "service_giveback",
    "guest_bartending_event",
];
const ALLOWED_CAMPAIGN_STATUSES = [
    "invitation_phase",
    "ready_to_launch",
    "live",
    "in_review",
];
function mapRequestRow(row) {
    const token = row.invite_token != null ? String(row.invite_token) : null;
    return {
        id: Number(row.id),
        campaignId: Number(row.campaign_id),
        campaignSlug: String(row.campaign_slug),
        campaignName: String(row.campaign_name),
        nonprofitName: String(row.organization_name),
        businessId: Number(row.business_id),
        businessName: String(row.business_name),
        businessEmail: typeof row.contact_email === "string" && row.contact_email.includes("@")
            ? String(row.contact_email).trim().toLowerCase()
            : null,
        locationId: Number(row.location_id),
        locationName: String(row.location_name),
        city: row.city != null ? String(row.city) : null,
        state: row.state != null ? String(row.state) : null,
        methodId: Number(row.method_id),
        methodType: String(row.method_type),
        methodName: String(row.method_name ?? methods_1.METHOD_LABELS[String(row.method_type)] ?? row.method_type),
        doorType: row.door_type === "restaurant" || row.door_type === "local"
            ? row.door_type
            : null,
        requestStatus: String(row.request_status),
        proposedGivebackPercentage: row.proposed_giveback_percentage != null
            ? Number(row.proposed_giveback_percentage)
            : null,
        message: row.message != null ? String(row.message) : null,
        campaignBusinessLocationId: row.campaign_business_location_id != null
            ? Number(row.campaign_business_location_id)
            : null,
        acceptPath: token ? `/?step=business-acceptance&token=${token}` : null,
        createdAt: String(row.created_at),
        respondedAt: row.responded_at != null ? String(row.responded_at) : null,
    };
}
const REQUEST_SELECT = `
  SELECT
    r.id, r.campaign_id, r.business_id, r.location_id, r.method_id,
    r.method_type, r.door_type, r.request_status,
    r.proposed_giveback_percentage, r.message,
    r.campaign_business_location_id, r.created_at, r.responded_at,
    c.slug AS campaign_slug, c.campaign_name,
    n.organization_name,
    b.business_name, b.contact_email,
    bl.location_name, bl.city, bl.state,
    cm.method_name,
    it.token AS invite_token
  FROM campaign_partner_join_requests r
  JOIN campaigns c ON c.id = r.campaign_id
  JOIN nonprofits n ON n.id = c.nonprofit_id
  JOIN businesses b ON b.id = r.business_id
  JOIN business_locations bl ON bl.id = r.location_id
  JOIN campaign_methods cm ON cm.id = r.method_id
  LEFT JOIN invitation_tokens it
    ON it.campaign_business_location_id = r.campaign_business_location_id
`;
function userBelongsToBusiness(user, businessId) {
    if (user.isPlatformAdmin)
        return true;
    return user.organizations.some((o) => o.organizationType === "business" && o.organizationId === businessId);
}
async function userMayManageCampaignNonprofit(user, campaign) {
    if (user.isPlatformAdmin)
        return true;
    const createdBy = campaign.created_by_user_id != null ? Number(campaign.created_by_user_id) : null;
    if (createdBy != null && createdBy === user.id)
        return true;
    const { rows } = await pool_1.pool.query(`SELECT 1 FROM organization_users
     WHERE organization_type = 'nonprofit'
       AND organization_id = $1
       AND user_id = $2
     LIMIT 1`, [Number(campaign.nonprofit_id), user.id]);
    return rows.length > 0;
}
async function loadCampaignBySlug(slug) {
    const clean = slug.replace(/\/+$/, "");
    const { rows } = await pool_1.pool.query(`SELECT c.id, c.slug, c.campaign_name, c.campaign_status, c.nonprofit_id,
            c.created_by_user_id, c.campaign_start_date, c.campaign_end_date,
            c.event_date, n.organization_name, n.contact_email
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.slug = $1
     LIMIT 1`, [clean]);
    return rows[0] ?? null;
}
async function createPartnerJoinRequest(input) {
    if (!userBelongsToBusiness(input.user, input.businessId)) {
        return { ok: false, status: 403, error: "Not allowed for this business" };
    }
    const campaign = await loadCampaignBySlug(input.slug);
    if (!campaign) {
        return { ok: false, status: 404, error: "Campaign not found" };
    }
    if (!ALLOWED_CAMPAIGN_STATUSES.includes(String(campaign.campaign_status))) {
        return {
            ok: false,
            status: 400,
            error: "This campaign is not accepting partner join requests right now",
        };
    }
    const { rows: methodRows } = await pool_1.pool.query(`SELECT id, method_type, method_name FROM campaign_methods WHERE campaign_id = $1`, [campaign.id]);
    const joinable = methodRows.filter((m) => methods_1.METHOD_REQUIRES_BUSINESS[String(m.method_type)]);
    if (joinable.length === 0) {
        return {
            ok: false,
            status: 400,
            error: "This campaign has no business fundraising methods to join",
        };
    }
    let methodRow = joinable[0];
    if (input.methodType) {
        if (!JOINABLE_METHOD_TYPES.includes(input.methodType)) {
            return { ok: false, status: 400, error: "Invalid methodType" };
        }
        const match = joinable.find((m) => String(m.method_type) === input.methodType);
        if (!match) {
            return {
                ok: false,
                status: 400,
                error: "That method is not part of this campaign",
            };
        }
        methodRow = match;
    }
    else if (input.doorType === "restaurant") {
        const dine = joinable.find((m) => String(m.method_type) === "dine_and_donate");
        if (dine)
            methodRow = dine;
    }
    else if (input.doorType === "local") {
        const shop = joinable.find((m) => ["shop_and_donate", "service_giveback"].includes(String(m.method_type)));
        if (shop)
            methodRow = shop;
    }
    const methodId = Number(methodRow.id);
    const methodType = String(methodRow.method_type);
    let locationId = input.locationId != null ? Number(input.locationId) : null;
    if (locationId == null || !Number.isFinite(locationId)) {
        const { rows: locs } = await pool_1.pool.query(`SELECT id FROM business_locations WHERE business_id = $1 ORDER BY id ASC LIMIT 1`, [input.businessId]);
        if (locs.length === 0) {
            return { ok: false, status: 400, error: "Business has no location to join with" };
        }
        locationId = Number(locs[0].id);
    }
    else {
        const { rows: locs } = await pool_1.pool.query(`SELECT id FROM business_locations WHERE id = $1 AND business_id = $2`, [locationId, input.businessId]);
        if (locs.length === 0) {
            return { ok: false, status: 400, error: "Location does not belong to this business" };
        }
    }
    const { rows: existingCbl } = await pool_1.pool.query(`SELECT id FROM campaign_business_locations
     WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3 AND method_id = $4
     LIMIT 1`, [campaign.id, input.businessId, locationId, methodId]);
    if (existingCbl.length > 0) {
        return {
            ok: false,
            status: 409,
            error: "This business is already invited or partnered on this campaign",
        };
    }
    const { rows: pending } = await pool_1.pool.query(`${REQUEST_SELECT}
     WHERE r.campaign_id = $1 AND r.business_id = $2 AND r.location_id = $3
       AND r.method_id = $4 AND r.request_status = 'pending'
     LIMIT 1`, [campaign.id, input.businessId, locationId, methodId]);
    if (pending.length > 0) {
        return {
            ok: false,
            status: 409,
            error: "A join request is already pending for this campaign",
            request: mapRequestRow(pending[0]),
        };
    }
    const proposed = input.proposedGivebackPercentage != null &&
        Number.isFinite(Number(input.proposedGivebackPercentage))
        ? Number(input.proposedGivebackPercentage)
        : null;
    const door = input.doorType === "restaurant" || input.doorType === "local"
        ? input.doorType
        : null;
    const message = input.message?.trim() || null;
    const { rows: inserted } = await pool_1.pool.query(`INSERT INTO campaign_partner_join_requests (
       campaign_id, business_id, location_id, method_id, method_type,
       door_type, request_status, proposed_giveback_percentage, message,
       requested_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
     RETURNING id`, [
        campaign.id,
        input.businessId,
        locationId,
        methodId,
        methodType,
        door,
        proposed,
        message,
        input.user.id,
    ]);
    const { rows: full } = await pool_1.pool.query(`${REQUEST_SELECT} WHERE r.id = $1`, [inserted[0].id]);
    const request = mapRequestRow(full[0]);
    const npoEmail = typeof campaign.contact_email === "string"
        ? campaign.contact_email.trim()
        : "";
    if (npoEmail.includes("@")) {
        const dash = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=dashboard&campaign=${campaign.slug}`;
        void (0, mailer_1.sendEmail)({
            to: npoEmail,
            name: String(campaign.organization_name),
            subject: `${request.businessName} wants to join ${campaign.campaign_name}`,
            body: `${request.businessName} requested to join your ForkUp campaign ` +
                `"${campaign.campaign_name}" as a ${methods_1.METHOD_LABELS[methodType]} partner.\n\n` +
                (message ? `Message: ${message}\n\n` : "") +
                `Review in your campaign dashboard:\n${dash}\n`,
            emailType: "partner_join_request_to_npo",
            campaignId: Number(campaign.id),
            stakeholderRole: "nonprofit",
            relatedToken: `cpjr:${request.id}`,
            onlyOnce: true,
            businessId: request.businessId,
        }).catch((err) => {
            console.error("[partner-join] NPO notify failed:", err);
        });
    }
    return { ok: true, request };
}
async function listPartnerJoinRequestsForCampaign(slug, status) {
    const campaign = await loadCampaignBySlug(slug);
    if (!campaign) {
        return { ok: false, status: 404, error: "Campaign not found" };
    }
    const filter = status && status !== "all" ? ` AND r.request_status = $2` : "";
    const params = [campaign.id];
    if (status && status !== "all")
        params.push(status);
    const { rows } = await pool_1.pool.query(`${REQUEST_SELECT}
     WHERE r.campaign_id = $1${filter}
     ORDER BY
       CASE r.request_status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
       r.created_at DESC`, params);
    return { ok: true, requests: rows.map(mapRequestRow) };
}
async function listMyPartnerJoinRequests(input) {
    if (!userBelongsToBusiness(input.user, input.businessId)) {
        return { ok: false, status: 403, error: "Not allowed for this business" };
    }
    const campaign = await loadCampaignBySlug(input.slug);
    if (!campaign) {
        return { ok: false, status: 404, error: "Campaign not found" };
    }
    const { rows } = await pool_1.pool.query(`${REQUEST_SELECT}
     WHERE r.campaign_id = $1 AND r.business_id = $2
     ORDER BY r.created_at DESC`, [campaign.id, input.businessId]);
    return { ok: true, requests: rows.map(mapRequestRow) };
}
async function acceptPartnerJoinRequest(input) {
    const campaign = await loadCampaignBySlug(input.slug);
    if (!campaign) {
        return { ok: false, status: 404, error: "Campaign not found" };
    }
    if (!(await userMayManageCampaignNonprofit(input.user, campaign))) {
        return { ok: false, status: 403, error: "Not allowed to manage this campaign" };
    }
    const connection = await pool_1.pool.connect();
    try {
        await connection.query("BEGIN");
        const { rows: reqRows } = await connection.query(`SELECT * FROM campaign_partner_join_requests
       WHERE id = $1 AND campaign_id = $2
       FOR UPDATE`, [input.requestId, campaign.id]);
        if (reqRows.length === 0) {
            await connection.query("ROLLBACK");
            return { ok: false, status: 404, error: "Join request not found" };
        }
        const joinReq = reqRows[0];
        if (String(joinReq.request_status) === "accepted") {
            const { rows: full } = await connection.query(`${REQUEST_SELECT} WHERE r.id = $1`, [joinReq.id]);
            await connection.query("COMMIT");
            const dto = mapRequestRow(full[0]);
            const token = full[0].invite_token != null ? String(full[0].invite_token) : "";
            return {
                ok: true,
                request: dto,
                invitationToken: token,
                acceptPath: dto.acceptPath ?? "",
            };
        }
        if (String(joinReq.request_status) !== "pending") {
            await connection.query("ROLLBACK");
            return { ok: false, status: 400, error: "Join request is no longer pending" };
        }
        const businessId = Number(joinReq.business_id);
        const locationId = Number(joinReq.location_id);
        const methodId = Number(joinReq.method_id);
        const { rows: bizRows } = await connection.query(`SELECT id, business_name, contact_email, default_giveback_percentage
       FROM businesses WHERE id = $1`, [businessId]);
        if (bizRows.length === 0) {
            await connection.query("ROLLBACK");
            return { ok: false, status: 404, error: "Business not found" };
        }
        const biz = bizRows[0];
        let cblId = joinReq.campaign_business_location_id != null
            ? Number(joinReq.campaign_business_location_id)
            : null;
        if (cblId == null) {
            const { rows: existing } = await connection.query(`SELECT id FROM campaign_business_locations
         WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3 AND method_id = $4
         LIMIT 1`, [campaign.id, businessId, locationId, methodId]);
            if (existing.length > 0) {
                cblId = Number(existing[0].id);
            }
        }
        let token = "";
        if (cblId == null) {
            const inviteAnchorDate = (0, date_only_1.toDateOnlyString)(campaign.event_date) ||
                (0, date_only_1.toDateOnlyString)(campaign.campaign_start_date) ||
                (0, date_only_1.toDateOnlyString)(campaign.campaign_end_date);
            const respondByDate = (0, business_invite_timing_1.computeRespondByDate)({
                sentDate: new Date(),
                startOrEventDate: inviteAnchorDate,
            });
            const givebackPercentage = joinReq.proposed_giveback_percentage != null
                ? Number(joinReq.proposed_giveback_percentage)
                : Number(biz.default_giveback_percentage ?? 10);
            const messageToBusiness = typeof joinReq.message === "string" && joinReq.message.trim()
                ? `Join request: ${joinReq.message.trim()}`
                : "Accepted from public campaign join request";
            const businessEmail = (typeof biz.contact_email === "string" && biz.contact_email.trim()
                ? String(biz.contact_email).trim().toLowerCase()
                : "") || "unknown@invite.local";
            const { rows: cblResult } = await connection.query(`INSERT INTO campaign_business_locations (
          campaign_id, method_id, business_id, location_id,
          invite_status, acceptance_status, giveback_percentage,
          respond_by_date, invited_by_user_id, setup_status,
          message_to_business
        ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8)
         RETURNING id`, [
                campaign.id,
                methodId,
                businessId,
                locationId,
                givebackPercentage,
                respondByDate,
                input.user.id,
                messageToBusiness,
            ]);
            cblId = cblResult[0].id;
            token = await (0, invitations_1.ensureInvitationToken)(connection, cblId);
            await (0, business_invitation_record_1.insertBusinessInvitationRecord)(connection, {
                campaignId: Number(campaign.id),
                nonprofitId: Number(campaign.nonprofit_id),
                methodId,
                businessId,
                businessName: String(biz.business_name),
                businessEmail,
                campaignBusinessLocationId: cblId,
                respondByDate,
                invitedByUserId: input.user.id,
                proposedGivebackPercentage: givebackPercentage,
                messageToBusiness,
            });
        }
        else {
            token = await (0, invitations_1.ensureInvitationToken)(connection, cblId);
        }
        await connection.query(`UPDATE campaign_partner_join_requests SET
         request_status = 'accepted',
         campaign_business_location_id = $1,
         responded_at = NOW(),
         responded_by_user_id = $2,
         updated_at = NOW()
       WHERE id = $3`, [cblId, input.user.id, joinReq.id]);
        const { rows: full } = await connection.query(`${REQUEST_SELECT} WHERE r.id = $1`, [joinReq.id]);
        await connection.query("COMMIT");
        const dto = mapRequestRow(full[0]);
        void (0, business_lifecycle_emails_1.sendInitialInvitationEmails)(Number(campaign.id), {
            cblId: cblId ?? undefined,
        }).catch((err) => {
            console.error("[partner-join] invite email failed:", err);
        });
        return {
            ok: true,
            request: dto,
            invitationToken: token || String(full[0].invite_token ?? ""),
            acceptPath: dto.acceptPath ?? `/?step=business-acceptance&token=${token}`,
        };
    }
    catch (err) {
        await connection.query("ROLLBACK");
        throw err;
    }
    finally {
        connection.release();
    }
}
async function declinePartnerJoinRequest(input) {
    const campaign = await loadCampaignBySlug(input.slug);
    if (!campaign) {
        return { ok: false, status: 404, error: "Campaign not found" };
    }
    if (!(await userMayManageCampaignNonprofit(input.user, campaign))) {
        return { ok: false, status: 403, error: "Not allowed to manage this campaign" };
    }
    const { rows: reqRows } = await pool_1.pool.query(`SELECT * FROM campaign_partner_join_requests
     WHERE id = $1 AND campaign_id = $2`, [input.requestId, campaign.id]);
    if (reqRows.length === 0) {
        return { ok: false, status: 404, error: "Join request not found" };
    }
    if (String(reqRows[0].request_status) !== "pending") {
        return { ok: false, status: 400, error: "Join request is no longer pending" };
    }
    const reason = input.reason?.trim() || null;
    const nextMessage = reason && reqRows[0].message
        ? `${String(reqRows[0].message)}\n\nDecline note: ${reason}`
        : reason
            ? `Decline note: ${reason}`
            : reqRows[0].message;
    await pool_1.pool.query(`UPDATE campaign_partner_join_requests SET
       request_status = 'declined',
       message = $1,
       responded_at = NOW(),
       responded_by_user_id = $2,
       updated_at = NOW()
     WHERE id = $3`, [nextMessage, input.user.id, input.requestId]);
    const { rows: full } = await pool_1.pool.query(`${REQUEST_SELECT} WHERE r.id = $1`, [input.requestId]);
    return { ok: true, request: mapRequestRow(full[0]) };
}
//# sourceMappingURL=campaign-partner-join-requests.js.map