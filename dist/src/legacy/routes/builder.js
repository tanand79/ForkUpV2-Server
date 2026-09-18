"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.builderRouter = void 0;
const express_1 = require("express");
const invitations_1 = require("../lib/invitations");
const slug_1 = require("../lib/slug");
const methods_1 = require("../lib/methods");
const date_only_1 = require("../lib/date-only");
const auth_1 = require("../lib/auth");
const s3_1 = require("../lib/s3");
const ensure_durable_image_1 = require("../lib/ensure-durable-image");
const guest_campaign_claim_1 = require("../lib/guest-campaign-claim");
const organization_library_1 = require("../lib/organization-library");
const campaign_timing_1 = require("../lib/campaign-timing");
const business_invite_timing_1 = require("../lib/business-invite-timing");
const business_invitation_record_1 = require("../lib/business-invitation-record");
const business_lifecycle_emails_1 = require("../lib/business-lifecycle-emails");
const invite_sender_1 = require("../lib/invite-sender");
const pool_1 = require("../db/pool");
const geo_distance_1 = require("../lib/geo-distance");
const assert_may_link_organization_1 = require("../lib/assert-may-link-organization");
const featured_youtube_1 = require("../lib/featured-youtube");
async function sendBusinessInviteEmails(campaignId) {
    await (0, business_lifecycle_emails_1.sendInitialInvitationEmails)(campaignId);
}
exports.builderRouter = (0, express_1.Router)();
function resolveMethodsForSave(body) {
    let methods = withImpliedAmbassador(body.methods ?? []);
    if (body.continueWithoutBusinessMethods) {
        methods = methods.filter((m) => !methods_1.METHOD_REQUIRES_BUSINESS[m]);
    }
    return methods;
}
function resolveStartDate(body, methods) {
    const explicit = (0, date_only_1.toDateOnlyString)(body.startDate);
    if (explicit)
        return explicit;
    if (body.launch && !(0, campaign_timing_1.hasBusinessMethods)(methods)) {
        return (0, date_only_1.toDateOnlyString)(new Date());
    }
    return null;
}
function timingFieldsFromEvaluation(evaluation, body) {
    const wantsForkupReview = evaluation.status === "tight_timeline" &&
        Boolean(body.submitForForkupReview);
    if (wantsForkupReview) {
        return {
            businessTimingStatus: "needs_forkup_review",
            forkupReviewStatus: "pending",
            forkupReviewReason: evaluation.message ||
                "Campaign submitted for ForkUp review (tight business-method timeline).",
            forkupReviewRequestedAt: new Date(),
        };
    }
    return {
        businessTimingStatus: evaluation.status,
        forkupReviewStatus: "none",
        forkupReviewReason: null,
        forkupReviewRequestedAt: null,
    };
}
function confirmationFromBody(body) {
    return {
        confirmedBusinessName: body.confirmedBusinessName,
        confirmedContactName: body.confirmedContactName,
        confirmedContactEmail: body.confirmedContactEmail,
        confirmedMethod: body.confirmedMethod,
        confirmedStatus: body.confirmedStatus,
        confirmedNotes: body.confirmedNotes,
    };
}
async function applyNonprofitInviteSender(connection, campaignId, nonprofitId, inviteSenderUserId) {
    const senderId = (0, invite_sender_1.parseSenderUserId)(inviteSenderUserId);
    if (senderId == null)
        return null;
    const headers = await (0, invite_sender_1.resolveOrgMemberSender)("nonprofit", nonprofitId, senderId, connection);
    if (!headers) {
        return "inviteSenderUserId must be a member of this nonprofit";
    }
    await (0, invite_sender_1.setCampaignInviteSenderUserId)(campaignId, senderId, connection);
    return null;
}
function businessTimingSaveError(evaluation, body, methods) {
    if (!(0, campaign_timing_1.hasBusinessMethods)(methods))
        return null;
    if (evaluation.status === "too_soon") {
        return "This start/event date is too soon for a new business-based campaign (0–7 days). Change the date or continue with Online Donation / Ambassador Sharing only.";
    }
    const confirmation = confirmationFromBody(body);
    if ((0, campaign_timing_1.hasAnyBusinessConfirmationField)(confirmation)) {
        const confErr = (0, campaign_timing_1.validateBusinessConfirmation)(confirmation);
        if (confErr)
            return confErr;
    }
    if (evaluation.status === "tight_timeline" &&
        body.launch &&
        !body.submitForForkupReview &&
        !(0, campaign_timing_1.isBusinessConfirmationComplete)(confirmation)) {
        return "Tight timeline (8–20 days): confirm an existing business agreement, submit for ForkUp review, change the date, or continue without business methods.";
    }
    return null;
}
function launchRequiresForkupReview(timingFields) {
    return timingFields.forkupReviewStatus === "pending";
}
function formatDate(value) {
    return (0, date_only_1.toDateOnlyString)(value);
}
function midpointDate(startDate, endDate) {
    const start = (0, date_only_1.toDateOnlyString)(startDate);
    const end = (0, date_only_1.toDateOnlyString)(endDate);
    if (!start || !end)
        return startDate;
    const startMs = new Date(`${start}T00:00:00`).getTime();
    const endMs = new Date(`${end}T00:00:00`).getTime();
    const spanDays = Math.max(0, Math.round((endMs - startMs) / 86_400_000));
    return (0, date_only_1.addCalendarDays)(start, Math.floor(spanDays / 2));
}
function buildAutomatedReminders(startDate, endDate, impactSnippet) {
    const start = (0, date_only_1.toDateOnlyString)(startDate);
    const end = (0, date_only_1.toDateOnlyString)(endDate);
    if (!start || !end)
        return [];
    return [
        {
            action_type: "mid_campaign_reminder",
            title: "Mid-Campaign Reminder",
            content: `We're halfway there — remind supporters to visit participating businesses and upload their receipts.${impactSnippet ? `\n\n${impactSnippet}` : ""}`,
            scheduled_date: midpointDate(start, end),
        },
        {
            action_type: "receipt_reminder",
            title: "Receipt Upload Reminder",
            content: "The campaign has wrapped up — remind supporters to upload any remaining receipts so their visits count toward the goal.",
            scheduled_date: (0, date_only_1.addCalendarDays)(end, 2),
        },
    ];
}
async function insertSuccessEngineDraft(connection, campaignId, campaignName, startDate, endDate, nonprofitId) {
    const { rows: existing } = await connection.query("SELECT id FROM success_engine_actions WHERE campaign_id = $1 LIMIT 1", [campaignId]);
    if (existing.length > 0)
        return;
    const approvedItems = nonprofitId
        ? await (0, organization_library_1.fetchApprovedLibraryItems)("nonprofit", nonprofitId)
        : [];
    const snippet = nonprofitId ? (0, organization_library_1.pickLaunchSnippet)(approvedItems) : null;
    const impactSnippet = nonprofitId ? (0, organization_library_1.pickImpactSnippet)(approvedItems) : null;
    const launchContent = `Your campaign "${campaignName}" is live. Share it with supporters and encourage them to participate at your confirmed businesses.${snippet ? `\n\n${snippet}` : ""}`;
    const actions = [
        {
            action_type: "launch_email",
            title: "Campaign Launch Email",
            content: launchContent,
            scheduled_date: startDate,
        },
        {
            action_type: "one_week_reminder",
            title: "One Week Reminder",
            content: `One week left — remind supporters to visit participating businesses and upload receipts.${impactSnippet ? `\n\n${impactSnippet}` : ""}`,
            scheduled_date: endDate,
        },
        {
            action_type: "final_push_reminder",
            title: "Final Push Reminder",
            content: `Final days of the campaign — share progress and encourage last-minute participation.${impactSnippet ? `\n\n${impactSnippet}` : ""}`,
            scheduled_date: endDate,
        },
    ];
    for (const action of actions) {
        await connection.query(`INSERT INTO success_engine_actions (campaign_id, action_type, channel, scheduled_date, title, content, status)
       VALUES ($1, $2, 'email', $3, $4, $5, 'ready')`, [campaignId, action.action_type, action.scheduled_date, action.title, action.content]);
    }
    for (const action of buildAutomatedReminders(startDate, endDate, impactSnippet)) {
        await connection.query(`INSERT INTO success_engine_actions (campaign_id, action_type, channel, scheduled_date, title, content, status, auto_send)
       VALUES ($1, $2, 'email', $3, $4, $5, 'ready', TRUE)`, [campaignId, action.action_type, action.scheduled_date, action.title, action.content]);
    }
}
function isStartDateReached(startDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return start.getTime() <= today.getTime();
}
function withImpliedAmbassador(methods) {
    if (methods.includes("guest_bartending_event") &&
        !methods.includes("ambassador_fundraising")) {
        return [...methods, "ambassador_fundraising"];
    }
    return methods;
}
async function resolveLaunchStatus(connection, campaignId, startDate, selectedMethods) {
    let hasDefaultFundraisingLayer = false;
    if (selectedMethods && selectedMethods.length > 0) {
        hasDefaultFundraisingLayer = selectedMethods.some((m) => !methods_1.METHOD_REQUIRES_BUSINESS[m]);
    }
    else {
        const { rows: methods } = await connection.query(`SELECT requires_business_acceptance
       FROM campaign_methods WHERE campaign_id = $1`, [campaignId]);
        hasDefaultFundraisingLayer = methods.some((m) => !Boolean(m.requires_business_acceptance));
    }
    if (!hasDefaultFundraisingLayer) {
        const { rows: pending } = await connection.query(`SELECT id FROM campaign_business_locations
       WHERE campaign_id = $1
         AND acceptance_status NOT IN ('accepted', 'live', 'completed')
       LIMIT 1`, [campaignId]);
        if (pending.length > 0)
            return "invitation_phase";
        const { rows: partners } = await connection.query(`SELECT id FROM campaign_business_locations WHERE campaign_id = $1 LIMIT 1`, [campaignId]);
        if (partners.length === 0)
            return "invitation_phase";
    }
    if (startDate && isStartDateReached(startDate))
        return "live";
    return "ready_to_launch";
}
function businessSupportsMethod(row, methodType) {
    const cap = methods_1.METHOD_CAPABILITY[methodType];
    return Boolean(row[cap]);
}
function resolvePersistedMethodType(biz, requested, methodIdByType) {
    if (businessSupportsMethod(biz, requested) && methodIdByType.has(requested)) {
        return requested;
    }
    const fallbacks = [
        "dine_and_donate",
        "shop_and_donate",
        "service_giveback",
        "guest_bartending_event",
    ];
    for (const methodType of fallbacks) {
        if (methodIdByType.has(methodType) && businessSupportsMethod(biz, methodType)) {
            return methodType;
        }
    }
    return null;
}
function partnerInviteKey(businessId, locationId, methodType) {
    return `${businessId}:${locationId}:${methodType}`;
}
function partnerEmailMethodKey(email, methodType) {
    return `${email.trim().toLowerCase()}:${methodType}`;
}
async function upsertNewBusinessInvite(connection, params) {
    const { campaignId, nonprofitId, methodId, invite, existingPartnerKeys, existingPartnerEmails, startOrEventDate, invitedByUserId, } = params;
    const email = invite.businessEmail.trim().toLowerCase();
    const name = invite.businessName.trim();
    if (!email.includes("@") || !name)
        return false;
    const emailMethodKey = partnerEmailMethodKey(email, invite.methodType);
    if (existingPartnerEmails.has(emailMethodKey))
        return false;
    const { rows: existingCbl } = await connection.query(`SELECT cbl.id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     WHERE cbl.campaign_id = $1
       AND LOWER(b.contact_email) = $2
       AND cbl.method_id = $3
     LIMIT 1`, [campaignId, email, methodId]);
    if (existingCbl.length > 0) {
        existingPartnerEmails.add(emailMethodKey);
        return false;
    }
    let businessId;
    let locationId;
    const { rows: existingBiz } = await connection.query(`SELECT b.id AS business_id, bl.id AS location_id
     FROM businesses b
     LEFT JOIN business_locations bl ON bl.business_id = b.id AND bl.active_status = TRUE
     WHERE LOWER(b.contact_email) = $1
     ORDER BY bl.id ASC
     LIMIT 1`, [email]);
    if (existingBiz.length > 0) {
        businessId = Number(existingBiz[0].business_id);
        locationId = Number(existingBiz[0].location_id);
        if (!locationId) {
            const { rows: locResult } = await connection.query(`INSERT INTO business_locations (business_id, location_name, city, state)
         VALUES ($1, 'Main Location', 'TBD', 'TBD') RETURNING id`, [businessId]);
            locationId = locResult[0].id;
        }
    }
    else {
        const newBizSlug = name
            .toLowerCase()
            .replace(/[^\w]+/g, "-")
            .slice(0, 200);
        const { rows: bizResult } = await connection.query(`INSERT INTO businesses (
          business_name, slug, contact_email, business_status, claim_status,
          supports_dine_and_donate, supports_shop_and_donate,
          supports_service_giveback, supports_guest_bartending
        ) VALUES ($1, $2, $3, 'invited', 'unclaimed', $4, $5, $6, $7) RETURNING id`, [
            name,
            `${newBizSlug}-${Date.now()}`,
            email,
            invite.methodType === "dine_and_donate",
            invite.methodType === "shop_and_donate",
            invite.methodType === "service_giveback",
            invite.methodType === "guest_bartending_event",
        ]);
        businessId = bizResult[0].id;
        const { rows: locResult } = await connection.query(`INSERT INTO business_locations (business_id, location_name, city, state)
       VALUES ($1, 'Main Location', 'TBD', 'TBD') RETURNING id`, [businessId]);
        locationId = locResult[0].id;
    }
    const partnerKey = partnerInviteKey(businessId, locationId, invite.methodType);
    if (existingPartnerKeys.has(partnerKey)) {
        existingPartnerEmails.add(emailMethodKey);
        return false;
    }
    const respondByDate = (0, business_invite_timing_1.computeRespondByDate)({
        sentDate: new Date(),
        startOrEventDate,
    });
    const givebackPercentage = 10;
    const messageToBusiness = invite.messageToBusiness?.trim() || null;
    const proposedTerms = invite.proposedTerms?.trim() || null;
    const { rows: cblResult } = await connection.query(`INSERT INTO campaign_business_locations (
      campaign_id, method_id, business_id, location_id,
      invite_status, acceptance_status, giveback_percentage,
      respond_by_date, invited_by_user_id, setup_status,
      message_to_business, proposed_terms
    ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
     RETURNING id`, [
        campaignId,
        methodId,
        businessId,
        locationId,
        givebackPercentage,
        respondByDate,
        invitedByUserId ?? null,
        messageToBusiness,
        proposedTerms,
    ]);
    await (0, invitations_1.ensureInvitationToken)(connection, cblResult[0].id);
    await (0, business_invitation_record_1.insertBusinessInvitationRecord)(connection, {
        campaignId,
        nonprofitId,
        methodId,
        businessId,
        businessName: name,
        businessEmail: email,
        campaignBusinessLocationId: cblResult[0].id,
        respondByDate,
        invitedByUserId,
        proposedGivebackPercentage: givebackPercentage,
        messageToBusiness,
        proposedTerms,
    });
    existingPartnerKeys.add(partnerKey);
    existingPartnerEmails.add(emailMethodKey);
    return true;
}
async function linkUserToNonprofit(connection, userId, nonprofitId) {
    const mayLink = await (0, assert_may_link_organization_1.assertUserMayLinkOrganization)(connection, {
        userId,
        organizationType: "nonprofit",
        organizationId: nonprofitId,
    });
    if (!mayLink.ok) {
        return;
    }
    await connection.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
     VALUES ('nonprofit', $1, $2, 'admin')
     ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`, [nonprofitId, userId]);
}
exports.builderRouter.get("/businesses", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const origin = (0, geo_distance_1.parseLatLng)(req.query.lat, req.query.lng);
        const radiusMiles = (0, geo_distance_1.parseRadiusMiles)(req.query.radiusMiles);
        const params = [];
        let where = "WHERE bl.active_status = TRUE";
        if (q) {
            where += " AND (b.business_name ILIKE $1 OR bl.city ILIKE $2 OR bl.location_name ILIKE $3)";
            const like = `%${q}%`;
            params.push(like, like, like);
        }
        const { rows: rows } = await pool_1.pool.query(`SELECT
         b.id,
         b.business_name,
         b.business_type,
         b.default_giveback_percentage,
         b.supports_dine_and_donate,
         b.supports_shop_and_donate,
         b.supports_service_giveback,
         b.supports_guest_bartending,
         bl.id AS location_id,
         bl.location_name,
         bl.city,
         bl.state,
         bl.latitude,
         bl.longitude
       FROM businesses b
       JOIN business_locations bl ON bl.business_id = b.id
       ${where}
       ORDER BY b.business_name, bl.location_name`, params);
        const grouped = new Map();
        for (const row of rows) {
            const nearby = (0, geo_distance_1.nearbyKeepDecision)(origin, row.latitude, row.longitude, radiusMiles);
            if (!nearby.keep)
                continue;
            const capabilities = Object.keys(methods_1.METHOD_CAPABILITY).filter((m) => businessSupportsMethod(row, m));
            if (!grouped.has(row.id)) {
                grouped.set(row.id, {
                    id: row.id,
                    businessName: row.business_name,
                    businessType: row.business_type ?? "Business",
                    defaultGivebackPercentage: Number(row.default_giveback_percentage ?? 10),
                    capabilities,
                    locations: [],
                    _nearestMiles: null,
                });
            }
            const entry = grouped.get(row.id);
            entry.locations.push({
                id: row.location_id,
                locationName: row.location_name,
                city: row.city ?? "",
                state: row.state ?? "",
                distanceMiles: nearby.distanceMiles,
            });
            if (nearby.distanceMiles != null) {
                if (entry._nearestMiles == null || nearby.distanceMiles < entry._nearestMiles) {
                    entry._nearestMiles = nearby.distanceMiles;
                }
            }
        }
        const payload = [...grouped.values()]
            .sort((a, b) => {
            if (origin) {
                const da = a._nearestMiles;
                const db = b._nearestMiles;
                if (da != null && db != null && da !== db)
                    return da - db;
                if (da != null && db == null)
                    return -1;
                if (da == null && db != null)
                    return 1;
            }
            return a.businessName.localeCompare(b.businessName);
        })
            .map(({ _nearestMiles: _drop, ...rest }) => rest);
        res.json(payload);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch businesses" });
    }
});
exports.builderRouter.get("/campaigns/:slug", async (req, res) => {
    try {
        const slug = req.params.slug.replace(/\/+$/, "");
        const { rows: campaigns } = await pool_1.pool.query(`SELECT c.id, c.slug, c.nonprofit_id, c.campaign_name, c.campaign_story, c.campaign_goal,
              c.campaign_start_date, c.campaign_end_date, c.cover_image_url,
              c.featured_youtube_url, c.campaign_status, c.invite_sender_user_id
       FROM campaigns c WHERE c.slug = $1`, [slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const { rows: methods } = await pool_1.pool.query(`SELECT method_type FROM campaign_methods WHERE campaign_id = $1 ORDER BY id`, [campaign.id]);
        const { rows: partners } = await pool_1.pool.query(`SELECT
         cbl.business_id, cbl.location_id, cbl.giveback_percentage, cbl.acceptance_status,
         b.business_name, b.contact_email AS business_email,
         bl.location_name, bl.city, bl.state,
         cm.method_type
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1
       ORDER BY b.business_name, bl.location_name`, [campaign.id]);
        const { rows: originRows } = await pool_1.pool.query(`SELECT id FROM nonprofit_campaign_invitations
       WHERE campaign_id = $1 AND invitation_status = 'accepted' LIMIT 1`, [campaign.id]);
        res.json({
            slug: campaign.slug,
            nonprofitId: Number(campaign.nonprofit_id),
            campaignName: campaign.campaign_name,
            campaignStory: campaign.campaign_story,
            campaignGoal: Number(campaign.campaign_goal ?? 0),
            startDate: formatDate(campaign.campaign_start_date),
            endDate: formatDate(campaign.campaign_end_date),
            coverImageUrl: await (0, s3_1.resolveStoredImageUrl)(campaign.cover_image_url),
            featuredYoutubeUrl: campaign.featured_youtube_url != null &&
                String(campaign.featured_youtube_url).trim()
                ? String(campaign.featured_youtube_url).trim()
                : null,
            status: campaign.campaign_status,
            origin: originRows.length > 0 ? "business_invite" : "nonprofit",
            inviteSenderUserId: campaign.invite_sender_user_id != null
                ? Number(campaign.invite_sender_user_id)
                : null,
            methods: methods.map((m) => m.method_type),
            partners: partners.map((p) => ({
                businessId: p.business_id,
                locationId: p.location_id,
                businessName: p.business_name,
                businessEmail: p.business_email,
                locationName: p.location_name,
                city: p.city,
                state: p.state,
                methodType: p.method_type,
                givebackPercentage: Number(p.giveback_percentage),
                acceptanceStatus: p.acceptance_status,
            })),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch campaign" });
    }
});
exports.builderRouter.patch("/campaigns/:slug", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const body = req.body;
        const slug = req.params.slug.replace(/\/+$/, "");
        if (!body.campaignName?.trim()) {
            res.status(400).json({ error: "Campaign name is required" });
            return;
        }
        if (!body.campaignStory?.trim()) {
            res.status(400).json({ error: "Campaign story is required" });
            return;
        }
        if (!Array.isArray(body.methods) || body.methods.length === 0) {
            res.status(400).json({ error: "Select at least one fundraising method" });
            return;
        }
        const methodsForSave = resolveMethodsForSave(body);
        if (methodsForSave.length === 0) {
            res.status(400).json({ error: "Select at least one fundraising method" });
            return;
        }
        const dateError = (0, campaign_timing_1.validateMethodDateRequirements)({
            methods: methodsForSave,
            startDate: body.startDate,
            endDate: body.endDate,
            eventDate: body.eventDate,
        });
        if (dateError) {
            res.status(400).json({ error: dateError });
            return;
        }
        if (!body.coverImage?.trim()) {
            res.status(400).json({ error: "Campaign cover image is required" });
            return;
        }
        if (body.coverImage.startsWith("blob:") ||
            body.coverImage.startsWith("data:")) {
            res.status(400).json({
                error: "Campaign cover image must be uploaded to storage before saving. Re-upload the featured image and try again.",
            });
            return;
        }
        const featuredYtParse = (0, featured_youtube_1.parseFeaturedYoutubeFromBody)(body);
        if (!featuredYtParse.ok) {
            res.status(400).json({ error: featuredYtParse.error });
            return;
        }
        let coverImageUrl;
        try {
            coverImageUrl = await (0, ensure_durable_image_1.ensureDurableImageUrl)(body.coverImage.trim(), "covers");
        }
        catch (mirrorErr) {
            console.warn("Failed to re-host builder cover image:", mirrorErr);
            res.status(400).json({
                error: "Could not store the campaign cover image. Upload the file directly or pick another image.",
            });
            return;
        }
        if (body.launch && !body.termsAccepted) {
            res.status(400).json({ error: "Terms must be accepted before launch" });
            return;
        }
        const timingEval = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
            methods: methodsForSave,
            startDate: body.startDate,
            eventDate: body.eventDate,
        });
        const timingGateError = businessTimingSaveError(timingEval, body, methodsForSave);
        if (timingGateError) {
            res.status(400).json({ error: timingGateError, timing: timingEval });
            return;
        }
        const timingFields = timingFieldsFromEvaluation(timingEval, body);
        const confirmation = confirmationFromBody(body);
        const businessConfirmed = (0, campaign_timing_1.isBusinessConfirmationComplete)(confirmation);
        await connection.query("BEGIN");
        const { rows: campaigns } = await connection.query("SELECT id, campaign_status, nonprofit_id, featured_youtube_url FROM campaigns WHERE slug = $1", [slug]);
        if (campaigns.length === 0) {
            await connection.query("ROLLBACK");
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(campaigns[0].id);
        const nonprofitId = Number(campaigns[0].nonprofit_id);
        const currentStatus = campaigns[0].campaign_status;
        const featuredYoutubeUrl = featuredYtParse.value === undefined
            ? campaigns[0].featured_youtube_url != null &&
                String(campaigns[0].featured_youtube_url).trim()
                ? String(campaigns[0].featured_youtube_url).trim()
                : null
            : featuredYtParse.value;
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (authUser)
            await linkUserToNonprofit(connection, authUser.id, nonprofitId);
        if (!["draft", "ready_to_launch", "in_review", "live", "invitation_phase"].includes(currentStatus) &&
            !body.launch) {
            res.status(400).json({ error: "This campaign can no longer be edited" });
            return;
        }
        const needsBusiness = (0, methods_1.requiresAnyBusiness)(methodsForSave);
        const resolvedStartDate = resolveStartDate(body, methodsForSave);
        const resolvedEndDate = (0, date_only_1.toDateOnlyString)(body.endDate);
        const resolvedEventDate = (0, date_only_1.toDateOnlyString)(body.eventDate);
        const { rows: existingPartners } = await connection.query(`SELECT cbl.business_id, cbl.location_id, cm.method_type,
              LOWER(b.contact_email) AS contact_email
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1`, [campaignId]);
        const existingPartnerKeys = new Set(existingPartners.map((p) => partnerInviteKey(String(p.business_id), String(p.location_id), String(p.method_type))));
        const existingPartnerEmails = new Set(existingPartners
            .map((p) => p.contact_email
            ? partnerEmailMethodKey(String(p.contact_email), String(p.method_type))
            : "")
            .filter(Boolean));
        const newInvitationCount = (body.invitations?.filter((inv) => !existingPartnerKeys.has(partnerInviteKey(inv.businessId, inv.locationId, inv.methodType))).length ?? 0) + (body.newBusinessInvites?.length ?? 0);
        const canInviteBusinessesEarly = (0, campaign_timing_1.allowsBusinessInviteEmails)(timingFields.businessTimingStatus, {
            businessConfirmed,
            forkupReviewStatus: timingFields.forkupReviewStatus,
        });
        if (needsBusiness &&
            body.launch &&
            canInviteBusinessesEarly &&
            existingPartners.length === 0 &&
            newInvitationCount === 0) {
            res.status(400).json({
                error: "At least one business location must be invited for the selected methods",
            });
            return;
        }
        const deadlineAnchor = resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
        const invitationDeadline = deadlineAnchor
            ? (0, date_only_1.subtractCalendarDays)(deadlineAnchor, 7)
            : null;
        const submitLaunchForReview = Boolean(body.launch) && launchRequiresForkupReview(timingFields);
        let nextStatus;
        if (currentStatus === "live" || currentStatus === "invitation_phase") {
            nextStatus = currentStatus;
        }
        else if (body.launch) {
            nextStatus = submitLaunchForReview
                ? "in_review"
                : await resolveLaunchStatus(connection, campaignId, resolvedStartDate ?? undefined, methodsForSave);
        }
        else if (currentStatus === "ready_to_launch") {
            nextStatus = "ready_to_launch";
        }
        else if (currentStatus === "in_review") {
            nextStatus = "in_review";
        }
        else {
            nextStatus = "draft";
        }
        await connection.query(`UPDATE campaigns SET
        campaign_name = $1,
        campaign_story = $2,
        campaign_goal = $3,
        campaign_start_date = $4,
        campaign_end_date = $5,
        event_date = $6,
        cover_image_url = $7,
        featured_youtube_url = $8,
        invitation_deadline = $9,
        campaign_status = $10,
        terms_accepted = $11,
        terms_accepted_at = CASE WHEN $12 THEN NOW() ELSE terms_accepted_at END,
        business_timing_status = $13,
        forkup_review_status = CASE
          WHEN $14 = 'pending' THEN 'pending'
          WHEN forkup_review_status = 'approved' THEN 'approved'
          ELSE $14
        END,
        forkup_review_reason = COALESCE($15, forkup_review_reason),
        forkup_review_requested_at = CASE
          WHEN $14 = 'pending' THEN COALESCE(forkup_review_requested_at, NOW())
          ELSE forkup_review_requested_at
        END,
        confirmed_business_name = COALESCE($17, confirmed_business_name),
        confirmed_contact_name = COALESCE($18, confirmed_contact_name),
        confirmed_contact_email = COALESCE($19, confirmed_contact_email),
        confirmed_method = COALESCE($20, confirmed_method),
        confirmed_status = COALESCE($21, confirmed_status),
        confirmed_notes = COALESCE($22, confirmed_notes),
        business_confirmed_at = CASE
          WHEN $23 THEN COALESCE(business_confirmed_at, NOW())
          ELSE business_confirmed_at
        END,
        updated_at = NOW()
       WHERE id = $16`, [
            body.campaignName.trim(),
            body.campaignStory.trim(),
            body.campaignGoal ?? 0,
            resolvedStartDate,
            resolvedEndDate,
            resolvedEventDate,
            coverImageUrl,
            featuredYoutubeUrl,
            invitationDeadline,
            nextStatus,
            body.termsAccepted,
            body.termsAccepted,
            timingFields.businessTimingStatus,
            timingFields.forkupReviewStatus,
            timingFields.forkupReviewReason,
            campaignId,
            businessConfirmed
                ? String(confirmation.confirmedBusinessName).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedContactName).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedContactEmail).trim().toLowerCase()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedMethod).trim().toLowerCase()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedStatus).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedNotes ?? "").trim() || null
                : null,
            businessConfirmed,
        ]);
        const inviteSenderError = await applyNonprofitInviteSender(connection, campaignId, nonprofitId, body.inviteSenderUserId);
        if (inviteSenderError) {
            await connection.query("ROLLBACK");
            res.status(400).json({ error: inviteSenderError });
            return;
        }
        const { rows: existingMethods } = await connection.query("SELECT id, method_type FROM campaign_methods WHERE campaign_id = $1", [campaignId]);
        const methodIdByType = new Map(existingMethods.map((m) => [m.method_type, Number(m.id)]));
        for (const methodType of methodsForSave) {
            if (methodIdByType.has(methodType)) {
                await connection.query(`UPDATE campaign_methods SET timing_status = $1, updated_at = NOW() WHERE id = $2`, [
                    methods_1.METHOD_REQUIRES_BUSINESS[methodType]
                        ? timingFields.businessTimingStatus
                        : "ok",
                    methodIdByType.get(methodType),
                ]);
                continue;
            }
            const { rows: methodResult } = await connection.query(`INSERT INTO campaign_methods (
          campaign_id, method_type, method_name, method_status,
          requires_business_acceptance, timing_status
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
                campaignId,
                methodType,
                methods_1.METHOD_LABELS[methodType],
                body.launch ? "invited" : "draft",
                methods_1.METHOD_REQUIRES_BUSINESS[methodType],
                methods_1.METHOD_REQUIRES_BUSINESS[methodType]
                    ? timingFields.businessTimingStatus
                    : "ok",
            ]);
            methodIdByType.set(methodType, methodResult[0].id);
        }
        const canInviteBusinesses = (0, campaign_timing_1.allowsBusinessInviteEmails)(timingFields.businessTimingStatus, {
            businessConfirmed,
            forkupReviewStatus: timingFields.forkupReviewStatus,
        });
        const inviteAnchorDate = resolvedEventDate || resolvedStartDate || resolvedEndDate;
        const invitedByUserId = authUser?.id ?? null;
        for (const invite of body.invitations ?? []) {
            const { rows: bizRows } = await connection.query(`SELECT b.*, bl.id AS location_id
         FROM businesses b
         JOIN business_locations bl ON bl.business_id = b.id
         WHERE b.id = $1 AND bl.id = $2`, [invite.businessId, invite.locationId]);
            if (bizRows.length === 0)
                continue;
            const biz = bizRows[0];
            const methodType = resolvePersistedMethodType(biz, invite.methodType, methodIdByType);
            if (!methodType)
                continue;
            const methodId = methodIdByType.get(methodType);
            if (!methodId)
                continue;
            const key = partnerInviteKey(invite.businessId, invite.locationId, methodType);
            if (existingPartnerKeys.has(key))
                continue;
            const respondByDate = (0, business_invite_timing_1.computeRespondByDate)({
                sentDate: new Date(),
                startOrEventDate: inviteAnchorDate,
            });
            const givebackPercentage = invite.givebackPercentage ?? biz.default_giveback_percentage ?? 10;
            const messageToBusiness = invite.messageToBusiness?.trim() || null;
            const proposedTerms = invite.proposedTerms?.trim() || null;
            const businessEmail = (invite.businessEmail?.trim() ||
                (biz.contact_email ? String(biz.contact_email).trim() : "") ||
                "").toLowerCase() || "unknown@invite.local";
            const { rows: cblResult } = await connection.query(`INSERT INTO campaign_business_locations (
          campaign_id, method_id, business_id, location_id,
          invite_status, acceptance_status, giveback_percentage,
          respond_by_date, invited_by_user_id, setup_status,
          message_to_business, proposed_terms
        ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
         RETURNING id`, [
                campaignId,
                methodId,
                invite.businessId,
                invite.locationId,
                givebackPercentage,
                respondByDate,
                invitedByUserId,
                messageToBusiness,
                proposedTerms,
            ]);
            await (0, invitations_1.ensureInvitationToken)(connection, cblResult[0].id);
            await (0, business_invitation_record_1.insertBusinessInvitationRecord)(connection, {
                campaignId,
                nonprofitId,
                methodId,
                businessId: invite.businessId,
                businessName: String(biz.business_name),
                businessEmail,
                campaignBusinessLocationId: cblResult[0].id,
                respondByDate,
                invitedByUserId,
                proposedGivebackPercentage: Number(givebackPercentage),
                messageToBusiness,
                proposedTerms,
            });
            existingPartnerKeys.add(key);
            if (biz.contact_email) {
                existingPartnerEmails.add(partnerEmailMethodKey(String(biz.contact_email), methodType));
            }
        }
        for (const invite of body.newBusinessInvites ?? []) {
            const methodId = methodIdByType.get(invite.methodType);
            if (!methodId)
                continue;
            await upsertNewBusinessInvite(connection, {
                campaignId,
                nonprofitId,
                methodId,
                invite,
                existingPartnerKeys,
                existingPartnerEmails,
                startOrEventDate: inviteAnchorDate,
                invitedByUserId,
            });
        }
        if (body.launch && submitLaunchForReview) {
            nextStatus = "in_review";
            await connection.query(`UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`, [nextStatus, campaignId]);
        }
        else if (body.launch) {
            nextStatus = await resolveLaunchStatus(connection, campaignId, resolvedStartDate ?? undefined, methodsForSave);
            await connection.query(`UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`, [nextStatus, campaignId]);
            await insertSuccessEngineDraft(connection, campaignId, body.campaignName.trim(), resolvedStartDate || resolvedEndDate || "", resolvedEndDate || resolvedStartDate || "", nonprofitId);
            await (0, invitations_1.maybePromoteCampaignToLive)(connection, campaignId);
            const { rows: statusRows } = await connection.query("SELECT campaign_status FROM campaigns WHERE id = $1", [campaignId]);
            nextStatus = String(statusRows[0]?.campaign_status ?? nextStatus);
        }
        await connection.query("COMMIT");
        const { rows: inviteRows } = await connection.query(`SELECT it.token, b.business_name, bl.location_name, cbl.acceptance_status, b.contact_email
       FROM campaign_business_locations cbl
       JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       WHERE cbl.campaign_id = $1`, [campaignId]);
        if (body.launch && !submitLaunchForReview && canInviteBusinesses) {
            await sendBusinessInviteEmails(campaignId);
        }
        res.json({
            slug,
            nonprofitId,
            campaignStatus: nextStatus,
            campaignName: body.campaignName,
            featuredYoutubeUrl,
            businessTimingStatus: timingFields.businessTimingStatus,
            forkupReviewStatus: timingFields.forkupReviewStatus,
            timing: timingEval,
            message: body.launch
                ? submitLaunchForReview
                    ? "Campaign submitted for ForkUp review"
                    : nextStatus === "invitation_phase"
                        ? "Campaign updated and moved to invitation phase"
                        : nextStatus === "live"
                            ? "Campaign is now live"
                            : "Campaign is scheduled and will appear publicly on the start date"
                : "Campaign saved",
            invitationLinks: inviteRows.map((row) => ({
                businessName: row.business_name,
                locationName: row.location_name,
                token: row.token,
                acceptanceStatus: row.acceptance_status,
                acceptPath: `/?step=business-acceptance&token=${row.token}`,
            })),
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to update campaign" });
    }
    finally {
        connection.release();
    }
});
exports.builderRouter.post("/campaigns", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const body = req.body;
        const guestLaunch = Boolean(body.guestLaunch);
        const guestEmailRaw = typeof body.guestEmail === "string" ? body.guestEmail.trim().toLowerCase() : "";
        if (guestLaunch) {
            if (!guestEmailRaw.includes("@")) {
                res.status(400).json({
                    error: "Email is required to launch without an account (for claim / tracking).",
                });
                return;
            }
            if (!body.launch) {
                res.status(400).json({ error: "Guest launch requires launch: true" });
                return;
            }
        }
        if (!body.nonprofit?.organizationName?.trim()) {
            res.status(400).json({ error: "Organization name is required" });
            return;
        }
        const effectiveContactEmail = (body.nonprofit.contactEmail?.includes("@")
            ? body.nonprofit.contactEmail
            : guestLaunch
                ? guestEmailRaw
                : body.nonprofit.contactEmail || "")
            .trim()
            .toLowerCase();
        if (!effectiveContactEmail.includes("@")) {
            res.status(400).json({ error: "Valid contact email is required" });
            return;
        }
        if (!body.campaignName?.trim()) {
            res.status(400).json({ error: "Campaign name is required" });
            return;
        }
        if (!body.campaignStory?.trim()) {
            res.status(400).json({ error: "Campaign story is required" });
            return;
        }
        if (!Array.isArray(body.methods) || body.methods.length === 0) {
            res.status(400).json({ error: "Select at least one fundraising method" });
            return;
        }
        const methodsForSave = resolveMethodsForSave(body);
        if (methodsForSave.length === 0) {
            res.status(400).json({ error: "Select at least one fundraising method" });
            return;
        }
        const dateError = (0, campaign_timing_1.validateMethodDateRequirements)({
            methods: methodsForSave,
            startDate: body.startDate,
            endDate: body.endDate,
            eventDate: body.eventDate,
        });
        if (dateError) {
            res.status(400).json({ error: dateError });
            return;
        }
        if (!body.coverImage?.trim()) {
            res.status(400).json({ error: "Campaign cover image is required" });
            return;
        }
        if (body.coverImage.startsWith("blob:") ||
            body.coverImage.startsWith("data:")) {
            res.status(400).json({
                error: "Campaign cover image must be uploaded to storage before saving. Re-upload the featured image and try again.",
            });
            return;
        }
        const featuredYtParseCreate = (0, featured_youtube_1.parseFeaturedYoutubeFromBody)(body);
        if (!featuredYtParseCreate.ok) {
            res.status(400).json({ error: featuredYtParseCreate.error });
            return;
        }
        const featuredYoutubeUrlCreate = featuredYtParseCreate.value === undefined
            ? null
            : featuredYtParseCreate.value;
        let coverImageUrl;
        try {
            coverImageUrl = await (0, ensure_durable_image_1.ensureDurableImageUrl)(body.coverImage.trim(), "covers");
        }
        catch (mirrorErr) {
            console.warn("Failed to re-host builder cover image:", mirrorErr);
            res.status(400).json({
                error: "Could not store the campaign cover image. Upload the file directly or pick another image.",
            });
            return;
        }
        if (body.launch && !body.termsAccepted) {
            res.status(400).json({ error: "Terms must be accepted before launch" });
            return;
        }
        const timingEval = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
            methods: methodsForSave,
            startDate: body.startDate,
            eventDate: body.eventDate,
        });
        const timingGateError = businessTimingSaveError(timingEval, body, methodsForSave);
        if (timingGateError) {
            res.status(400).json({ error: timingGateError, timing: timingEval });
            return;
        }
        const timingFields = timingFieldsFromEvaluation(timingEval, body);
        const confirmation = confirmationFromBody(body);
        const businessConfirmed = (0, campaign_timing_1.isBusinessConfirmationComplete)(confirmation);
        const hasInvitations = (body.invitations?.length ?? 0) + (body.newBusinessInvites?.length ?? 0) > 0;
        const needsBusiness = (0, methods_1.requiresAnyBusiness)(methodsForSave);
        const resolvedStartDate = resolveStartDate(body, methodsForSave);
        const resolvedEndDate = (0, date_only_1.toDateOnlyString)(body.endDate);
        const resolvedEventDate = (0, date_only_1.toDateOnlyString)(body.eventDate);
        const canInviteBusinesses = (0, campaign_timing_1.allowsBusinessInviteEmails)(timingFields.businessTimingStatus, {
            businessConfirmed,
            forkupReviewStatus: timingFields.forkupReviewStatus,
        });
        if (needsBusiness && body.launch && !hasInvitations && canInviteBusinesses) {
            res.status(400).json({
                error: "At least one business location must be invited for the selected methods",
            });
            return;
        }
        await connection.query("BEGIN");
        const email = effectiveContactEmail;
        const orgSlug = body.nonprofit.organizationName
            .toLowerCase()
            .replace(/[^\w]+/g, "-")
            .replace(/^-|-$/g, "");
        const requestedNonprofitId = typeof body.nonprofitId === "number" && body.nonprofitId > 0
            ? body.nonprofitId
            : null;
        let nonprofitId;
        if (requestedNonprofitId) {
            const { rows: byId } = await connection.query(`SELECT id, claim_status FROM nonprofits WHERE id = $1`, [requestedNonprofitId]);
            if (byId.length === 0) {
                await connection.query("ROLLBACK");
                res.status(404).json({ error: "Nonprofit not found" });
                return;
            }
            const claimStatus = String(byId[0].claim_status || "").toLowerCase();
            if (guestLaunch && claimStatus === "claimed") {
                await connection.query("ROLLBACK");
                res.status(403).json({
                    error: "This nonprofit is already claimed. Use Raise for them (fundraiser) or Request access.",
                });
                return;
            }
            nonprofitId = Number(byId[0].id);
            if (!guestLaunch) {
                await connection.query(`UPDATE nonprofits SET
            organization_name = $1,
            contact_name = $2,
            contact_email = $3,
            mission = COALESCE($4, mission),
            cause_category = COALESCE($5, cause_category),
            claim_status = 'claimed',
            updated_at = NOW()
           WHERE id = $6`, [
                    body.nonprofit.organizationName.trim(),
                    body.nonprofit.contactName?.trim() ??
                        body.nonprofit.organizationName.trim(),
                    email,
                    body.nonprofit.mission ?? null,
                    body.nonprofit.causeCategory ?? null,
                    nonprofitId,
                ]);
            }
        }
        else {
            const { rows: existingNp } = await connection.query("SELECT id, claim_status FROM nonprofits WHERE contact_email = $1 OR slug = $2", [email, orgSlug]);
            if (existingNp.length > 0) {
                const claimStatus = String(existingNp[0].claim_status || "").toLowerCase();
                if (guestLaunch && claimStatus === "claimed") {
                    await connection.query("ROLLBACK");
                    res.status(403).json({
                        error: "This nonprofit is already claimed. Use Raise for them (fundraiser) or Request access.",
                    });
                    return;
                }
                nonprofitId = Number(existingNp[0].id);
                if (guestLaunch) {
                    await connection.query(`UPDATE nonprofits SET
              organization_name = $1,
              contact_name = COALESCE(NULLIF($2, ''), contact_name),
              mission = COALESCE($3, mission),
              cause_category = COALESCE($4, cause_category),
              updated_at = NOW()
             WHERE id = $5`, [
                        body.nonprofit.organizationName.trim(),
                        body.nonprofit.contactName?.trim() ?? "",
                        body.nonprofit.mission ?? null,
                        body.nonprofit.causeCategory ?? null,
                        nonprofitId,
                    ]);
                }
                else {
                    await connection.query(`UPDATE nonprofits SET
              organization_name = $1,
              contact_name = $2,
              contact_email = $3,
              mission = COALESCE($4, mission),
              cause_category = COALESCE($5, cause_category),
              claim_status = 'claimed',
              updated_at = NOW()
             WHERE id = $6`, [
                        body.nonprofit.organizationName.trim(),
                        body.nonprofit.contactName?.trim() ??
                            body.nonprofit.organizationName.trim(),
                        email,
                        body.nonprofit.mission ?? null,
                        body.nonprofit.causeCategory ?? null,
                        nonprofitId,
                    ]);
                }
            }
            else {
                const { rows: npResult } = await connection.query(`INSERT INTO nonprofits (
            organization_name, slug, mission, cause_category,
            contact_name, contact_email, verification_status, claim_status
          ) VALUES ($1, $2, $3, $4, $5, $6, 'unclaimed', $7) RETURNING id`, [
                    body.nonprofit.organizationName.trim(),
                    orgSlug,
                    body.nonprofit.mission ?? null,
                    body.nonprofit.causeCategory ?? null,
                    body.nonprofit.contactName?.trim() ??
                        body.nonprofit.organizationName.trim(),
                    email,
                    guestLaunch ? "unclaimed" : "claimed",
                ]);
                nonprofitId = npResult[0].id;
            }
        }
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (authUser && !guestLaunch) {
            await linkUserToNonprofit(connection, authUser.id, nonprofitId);
        }
        const slug = await (0, slug_1.uniqueCampaignSlug)(body.campaignName, async (s) => {
            const { rows: rows } = await connection.query("SELECT id FROM campaigns WHERE slug = $1", [s]);
            return rows.length > 0;
        });
        const submitLaunchForReview = Boolean(body.launch) && launchRequiresForkupReview(timingFields);
        let campaignStatus = body.launch
            ? submitLaunchForReview
                ? "in_review"
                : "draft"
            : "draft";
        const deadlineAnchor = resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
        const invitationDeadline = deadlineAnchor
            ? (0, date_only_1.subtractCalendarDays)(deadlineAnchor, 7)
            : null;
        const { rows: campResult } = await connection.query(`INSERT INTO campaigns (
        slug, nonprofit_id, campaign_name, campaign_story, campaign_goal,
        campaign_start_date, campaign_end_date, event_date, campaign_status, cover_image_url,
        featured_youtube_url,
        invitation_deadline, terms_accepted, terms_accepted_at,
        business_timing_status, forkup_review_status, forkup_review_reason,
        forkup_review_requested_at,
        confirmed_business_name, confirmed_contact_name, confirmed_contact_email,
        confirmed_method, confirmed_status, confirmed_notes, business_confirmed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25
      )
       RETURNING id`, [
            slug,
            nonprofitId,
            body.campaignName.trim(),
            body.campaignStory.trim(),
            body.campaignGoal ?? 0,
            resolvedStartDate,
            resolvedEndDate,
            resolvedEventDate,
            campaignStatus,
            coverImageUrl,
            featuredYoutubeUrlCreate,
            invitationDeadline,
            body.termsAccepted,
            body.termsAccepted ? new Date() : null,
            timingFields.businessTimingStatus,
            timingFields.forkupReviewStatus,
            timingFields.forkupReviewReason,
            timingFields.forkupReviewRequestedAt,
            businessConfirmed
                ? String(confirmation.confirmedBusinessName).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedContactName).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedContactEmail).trim().toLowerCase()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedMethod).trim().toLowerCase()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedStatus).trim()
                : null,
            businessConfirmed
                ? String(confirmation.confirmedNotes ?? "").trim() || null
                : null,
            businessConfirmed ? new Date() : null,
        ]);
        const campaignId = campResult[0].id;
        const inviteSenderError = await applyNonprofitInviteSender(connection, campaignId, nonprofitId, body.inviteSenderUserId);
        if (inviteSenderError) {
            await connection.query("ROLLBACK");
            res.status(400).json({ error: inviteSenderError });
            return;
        }
        const methodIdByType = new Map();
        for (const methodType of methodsForSave) {
            const { rows: methodResult } = await connection.query(`INSERT INTO campaign_methods (
          campaign_id, method_type, method_name, method_status,
          requires_business_acceptance, timing_status
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
                campaignId,
                methodType,
                methods_1.METHOD_LABELS[methodType],
                body.launch ? "invited" : "draft",
                methods_1.METHOD_REQUIRES_BUSINESS[methodType],
                methods_1.METHOD_REQUIRES_BUSINESS[methodType]
                    ? timingFields.businessTimingStatus
                    : "ok",
            ]);
            methodIdByType.set(methodType, methodResult[0].id);
        }
        const existingPartnerKeys = new Set();
        const existingPartnerEmails = new Set();
        const inviteAnchorDate = resolvedEventDate || resolvedStartDate || resolvedEndDate;
        const invitedByUserId = authUser?.id ?? null;
        for (const invite of body.invitations ?? []) {
            const { rows: bizRows } = await connection.query(`SELECT b.*, bl.id AS location_id
         FROM businesses b
         JOIN business_locations bl ON bl.business_id = b.id
         WHERE b.id = $1 AND bl.id = $2`, [invite.businessId, invite.locationId]);
            if (bizRows.length === 0)
                continue;
            const biz = bizRows[0];
            const methodType = resolvePersistedMethodType(biz, invite.methodType, methodIdByType);
            if (!methodType)
                continue;
            const methodId = methodIdByType.get(methodType);
            if (!methodId)
                continue;
            const key = partnerInviteKey(invite.businessId, invite.locationId, methodType);
            if (existingPartnerKeys.has(key))
                continue;
            const respondByDate = (0, business_invite_timing_1.computeRespondByDate)({
                sentDate: new Date(),
                startOrEventDate: inviteAnchorDate,
            });
            const givebackPercentage = invite.givebackPercentage ?? biz.default_giveback_percentage ?? 10;
            const messageToBusiness = invite.messageToBusiness?.trim() || null;
            const proposedTerms = invite.proposedTerms?.trim() || null;
            const businessEmail = (invite.businessEmail?.trim() ||
                (biz.contact_email ? String(biz.contact_email).trim() : "") ||
                "").toLowerCase() || "unknown@invite.local";
            const { rows: cblResult } = await connection.query(`INSERT INTO campaign_business_locations (
          campaign_id, method_id, business_id, location_id,
          invite_status, acceptance_status, giveback_percentage,
          respond_by_date, invited_by_user_id, setup_status,
          message_to_business, proposed_terms
        ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
         RETURNING id`, [
                campaignId,
                methodId,
                invite.businessId,
                invite.locationId,
                givebackPercentage,
                respondByDate,
                invitedByUserId,
                messageToBusiness,
                proposedTerms,
            ]);
            await (0, invitations_1.ensureInvitationToken)(connection, cblResult[0].id);
            await (0, business_invitation_record_1.insertBusinessInvitationRecord)(connection, {
                campaignId,
                nonprofitId,
                methodId,
                businessId: invite.businessId,
                businessName: String(biz.business_name),
                businessEmail,
                campaignBusinessLocationId: cblResult[0].id,
                respondByDate,
                invitedByUserId,
                proposedGivebackPercentage: Number(givebackPercentage),
                messageToBusiness,
                proposedTerms,
            });
            existingPartnerKeys.add(key);
            if (biz.contact_email) {
                existingPartnerEmails.add(partnerEmailMethodKey(String(biz.contact_email), methodType));
            }
        }
        for (const invite of body.newBusinessInvites ?? []) {
            const methodId = methodIdByType.get(invite.methodType);
            if (!methodId)
                continue;
            await upsertNewBusinessInvite(connection, {
                campaignId,
                nonprofitId,
                methodId,
                invite,
                existingPartnerKeys,
                existingPartnerEmails,
                startOrEventDate: inviteAnchorDate,
                invitedByUserId,
            });
        }
        if (body.launch && submitLaunchForReview) {
            campaignStatus = "in_review";
            await connection.query(`UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`, [campaignStatus, campaignId]);
        }
        else if (body.launch) {
            campaignStatus = await resolveLaunchStatus(connection, campaignId, resolvedStartDate ?? undefined, methodsForSave);
            await connection.query(`UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`, [campaignStatus, campaignId]);
            await (0, invitations_1.maybePromoteCampaignToLive)(connection, campaignId);
            const { rows: statusRows } = await connection.query("SELECT campaign_status FROM campaigns WHERE id = $1", [campaignId]);
            campaignStatus = String(statusRows[0]?.campaign_status ?? campaignStatus);
            const seStart = resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
            const seEnd = resolvedEndDate || resolvedEventDate || resolvedStartDate || "";
            await insertSuccessEngineDraft(connection, campaignId, body.campaignName.trim(), seStart, seEnd, nonprofitId);
        }
        await connection.query("COMMIT");
        let guestClaimEmailSent = false;
        if (guestLaunch) {
            try {
                const issued = await (0, guest_campaign_claim_1.issueGuestCampaignClaim)({
                    campaignId,
                    slug,
                    campaignName: body.campaignName.trim(),
                    guestEmail: guestEmailRaw,
                });
                guestClaimEmailSent = issued.emailSent;
            }
            catch (claimErr) {
                console.error("Guest claim email failed after launch:", claimErr);
            }
        }
        const { rows: inviteRows } = await connection.query(`SELECT it.token, b.business_name, bl.location_name, cbl.acceptance_status, b.contact_email
       FROM campaign_business_locations cbl
       JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       WHERE cbl.campaign_id = $1`, [campaignId]);
        if (body.launch && !submitLaunchForReview && canInviteBusinesses) {
            await sendBusinessInviteEmails(campaignId);
        }
        res.status(201).json({
            slug,
            nonprofitId,
            campaignStatus,
            campaignName: body.campaignName,
            featuredYoutubeUrl: featuredYoutubeUrlCreate,
            businessTimingStatus: timingFields.businessTimingStatus,
            forkupReviewStatus: timingFields.forkupReviewStatus,
            timing: timingEval,
            guestLaunch: guestLaunch || undefined,
            guestClaimEmailSent: guestLaunch ? guestClaimEmailSent : undefined,
            guestClaimEmail: guestLaunch ? guestEmailRaw : undefined,
            message: body.launch
                ? submitLaunchForReview
                    ? "Campaign submitted for ForkUp review"
                    : campaignStatus === "invitation_phase"
                        ? "Campaign created — waiting on business partners"
                        : campaignStatus === "live"
                            ? "Campaign created and is now live"
                            : "Campaign created — it will appear publicly on the start date"
                : "Campaign saved as draft",
            invitationLinks: inviteRows.map((row) => ({
                businessName: row.business_name,
                locationName: row.location_name,
                token: row.token,
                acceptanceStatus: row.acceptance_status,
                acceptPath: `/?step=business-acceptance&token=${row.token}`,
            })),
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to create campaign" });
    }
    finally {
        connection.release();
    }
});
exports.builderRouter.post("/campaigns/:slug/resubmit-forkup-review", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Sign in required" });
            return;
        }
        const slug = req.params.slug.replace(/\/+$/, "");
        const { rows: campaigns } = await pool_1.pool.query(`SELECT id, slug, nonprofit_id, created_by_user_id, forkup_review_status
       FROM campaigns WHERE slug = $1 LIMIT 1`, [slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        if (String(campaign.forkup_review_status) !== "denied") {
            res.status(400).json({
                error: "Only a denied ForkUp review can be requested again",
            });
            return;
        }
        const nonprofitId = Number(campaign.nonprofit_id);
        const createdBy = campaign.created_by_user_id != null ? Number(campaign.created_by_user_id) : null;
        const isCreator = createdBy != null && createdBy === authUser.id;
        const { rows: membership } = await pool_1.pool.query(`SELECT 1 FROM organization_users
       WHERE organization_type = 'nonprofit'
         AND organization_id = $1
         AND user_id = $2
       LIMIT 1`, [nonprofitId, authUser.id]);
        if (!authUser.isPlatformAdmin && !isCreator && membership.length === 0) {
            res.status(403).json({ error: "Not allowed to resubmit this campaign" });
            return;
        }
        const { rows: updated } = await pool_1.pool.query(`UPDATE campaigns
       SET forkup_review_status = 'pending',
           forkup_review_requested_at = COALESCE(forkup_review_requested_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND forkup_review_status = 'denied'
       RETURNING slug, forkup_review_status`, [campaign.id]);
        if (updated.length === 0) {
            res.status(409).json({ error: "Campaign review could not be resubmitted" });
            return;
        }
        res.json({
            success: true,
            slug: String(updated[0].slug),
            forkupReviewStatus: String(updated[0].forkup_review_status),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to resubmit ForkUp review" });
    }
});
exports.builderRouter.post("/campaigns/:slug/business-invitations", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const slug = String(req.params.slug ?? "").replace(/\/+$/, "");
        const body = req.body;
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const invitations = Array.isArray(body.invitations) ? body.invitations : [];
        const newBusinessInvites = Array.isArray(body.newBusinessInvites)
            ? body.newBusinessInvites
            : [];
        if (invitations.length === 0 && newBusinessInvites.length === 0) {
            res.status(400).json({ error: "Add at least one business invitation" });
            return;
        }
        await connection.query("BEGIN");
        const { rows: campaigns } = await connection.query(`SELECT id, campaign_status, nonprofit_id, created_by_user_id,
              campaign_start_date, campaign_end_date, event_date,
              business_timing_status, forkup_review_status,
              confirmed_business_name, confirmed_contact_name,
              confirmed_contact_email, confirmed_method, confirmed_status
       FROM campaigns WHERE slug = $1`, [slug]);
        if (campaigns.length === 0) {
            await connection.query("ROLLBACK");
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const campaignId = Number(campaign.id);
        const nonprofitId = Number(campaign.nonprofit_id);
        const currentStatus = String(campaign.campaign_status);
        const allowedStatuses = [
            "invitation_phase",
            "ready_to_launch",
            "live",
            "in_review",
        ];
        if (!allowedStatuses.includes(currentStatus)) {
            await connection.query("ROLLBACK");
            res.status(400).json({
                error: "Businesses can only be invited while the campaign is in review, invitation, scheduled, or live",
            });
            return;
        }
        const createdBy = campaign.created_by_user_id != null
            ? Number(campaign.created_by_user_id)
            : null;
        const isCreator = createdBy != null && createdBy === authUser.id;
        const { rows: membership } = await connection.query(`SELECT 1 FROM organization_users
       WHERE organization_type = 'nonprofit'
         AND organization_id = $1
         AND user_id = $2
       LIMIT 1`, [nonprofitId, authUser.id]);
        if (!authUser.isPlatformAdmin && !isCreator && membership.length === 0) {
            await connection.query("ROLLBACK");
            res.status(403).json({ error: "Not allowed to invite businesses on this campaign" });
            return;
        }
        const inviteSenderError = await applyNonprofitInviteSender(connection, campaignId, nonprofitId, body.inviteSenderUserId);
        if (inviteSenderError) {
            await connection.query("ROLLBACK");
            res.status(400).json({ error: inviteSenderError });
            return;
        }
        const { rows: methodRows } = await connection.query(`SELECT id, method_type FROM campaign_methods WHERE campaign_id = $1`, [campaignId]);
        const methodIdByType = new Map();
        for (const row of methodRows) {
            methodIdByType.set(String(row.method_type), Number(row.id));
        }
        const hasBusinessMethod = [...methodIdByType.keys()].some((m) => methods_1.METHOD_REQUIRES_BUSINESS[m]);
        if (!hasBusinessMethod) {
            await connection.query("ROLLBACK");
            res.status(400).json({
                error: "This campaign has no business fundraising methods to invite partners for",
            });
            return;
        }
        const { rows: existingPartners } = await connection.query(`SELECT cbl.business_id, cbl.location_id, cm.method_type,
              LOWER(b.contact_email) AS contact_email
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1`, [campaignId]);
        const existingPartnerKeys = new Set(existingPartners.map((p) => partnerInviteKey(String(p.business_id), String(p.location_id), String(p.method_type))));
        const existingPartnerEmails = new Set(existingPartners
            .map((p) => p.contact_email
            ? partnerEmailMethodKey(String(p.contact_email), String(p.method_type))
            : "")
            .filter(Boolean));
        const inviteAnchorDate = (0, date_only_1.toDateOnlyString)(campaign.event_date) ||
            (0, date_only_1.toDateOnlyString)(campaign.campaign_start_date) ||
            (0, date_only_1.toDateOnlyString)(campaign.campaign_end_date);
        const invitedByUserId = authUser.id;
        let addedCount = 0;
        for (const invite of invitations) {
            const { rows: bizRows } = await connection.query(`SELECT b.*, bl.id AS location_id
         FROM businesses b
         JOIN business_locations bl ON bl.business_id = b.id
         WHERE b.id = $1 AND bl.id = $2`, [invite.businessId, invite.locationId]);
            if (bizRows.length === 0)
                continue;
            const biz = bizRows[0];
            const methodType = resolvePersistedMethodType(biz, invite.methodType, methodIdByType);
            if (!methodType)
                continue;
            const methodId = methodIdByType.get(methodType);
            if (!methodId)
                continue;
            const key = partnerInviteKey(invite.businessId, invite.locationId, methodType);
            if (existingPartnerKeys.has(key))
                continue;
            const respondByDate = (0, business_invite_timing_1.computeRespondByDate)({
                sentDate: new Date(),
                startOrEventDate: inviteAnchorDate,
            });
            const givebackPercentage = invite.givebackPercentage ?? biz.default_giveback_percentage ?? 10;
            const messageToBusiness = invite.messageToBusiness?.trim() || null;
            const proposedTerms = invite.proposedTerms?.trim() || null;
            const businessEmail = (invite.businessEmail?.trim() ||
                (biz.contact_email ? String(biz.contact_email).trim() : "") ||
                "").toLowerCase() || "unknown@invite.local";
            const { rows: cblResult } = await connection.query(`INSERT INTO campaign_business_locations (
          campaign_id, method_id, business_id, location_id,
          invite_status, acceptance_status, giveback_percentage,
          respond_by_date, invited_by_user_id, setup_status,
          message_to_business, proposed_terms
        ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
         RETURNING id`, [
                campaignId,
                methodId,
                invite.businessId,
                invite.locationId,
                givebackPercentage,
                respondByDate,
                invitedByUserId,
                messageToBusiness,
                proposedTerms,
            ]);
            await (0, invitations_1.ensureInvitationToken)(connection, cblResult[0].id);
            await (0, business_invitation_record_1.insertBusinessInvitationRecord)(connection, {
                campaignId,
                nonprofitId,
                methodId,
                businessId: invite.businessId,
                businessName: String(biz.business_name),
                businessEmail,
                campaignBusinessLocationId: cblResult[0].id,
                respondByDate,
                invitedByUserId,
                proposedGivebackPercentage: Number(givebackPercentage),
                messageToBusiness,
                proposedTerms,
            });
            existingPartnerKeys.add(key);
            if (biz.contact_email) {
                existingPartnerEmails.add(partnerEmailMethodKey(String(biz.contact_email), methodType));
            }
            addedCount += 1;
        }
        for (const invite of newBusinessInvites) {
            const methodId = methodIdByType.get(invite.methodType);
            if (!methodId)
                continue;
            const inserted = await upsertNewBusinessInvite(connection, {
                campaignId,
                nonprofitId,
                methodId,
                invite,
                existingPartnerKeys,
                existingPartnerEmails,
                startOrEventDate: inviteAnchorDate,
                invitedByUserId,
            });
            if (inserted)
                addedCount += 1;
        }
        await connection.query("COMMIT");
        const canEmail = (0, campaign_timing_1.allowsBusinessInviteEmails)(String(campaign.business_timing_status ?? "ok"), {
            businessConfirmed: (0, campaign_timing_1.isBusinessConfirmationComplete)({
                confirmedBusinessName: campaign.confirmed_business_name,
                confirmedContactName: campaign.confirmed_contact_name,
                confirmedContactEmail: campaign.confirmed_contact_email,
                confirmedMethod: campaign.confirmed_method,
                confirmedStatus: campaign.confirmed_status,
            }),
            forkupReviewStatus: String(campaign.forkup_review_status ?? "none"),
        });
        if (addedCount > 0 && canEmail) {
            await sendBusinessInviteEmails(campaignId);
        }
        const { rows: inviteRows } = await connection.query(`SELECT it.token, b.business_name, bl.location_name, cbl.acceptance_status, b.contact_email
       FROM campaign_business_locations cbl
       JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       WHERE cbl.campaign_id = $1
       ORDER BY cbl.id DESC`, [campaignId]);
        res.json({
            slug,
            campaignStatus: currentStatus,
            addedCount,
            message: addedCount > 0
                ? `Added ${addedCount} business invitation${addedCount === 1 ? "" : "s"}`
                : "No new invitations added (duplicates skipped)",
            invitationLinks: inviteRows.map((row) => ({
                businessName: row.business_name,
                locationName: row.location_name,
                token: row.token,
                acceptanceStatus: row.acceptance_status,
                acceptPath: `/?step=business-acceptance&token=${row.token}`,
            })),
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to append business invitations" });
    }
    finally {
        connection.release();
    }
});
//# sourceMappingURL=builder.js.map