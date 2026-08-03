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
const organization_library_1 = require("../lib/organization-library");
const campaign_timing_1 = require("../lib/campaign-timing");
const business_invite_timing_1 = require("../lib/business-invite-timing");
const business_invitation_record_1 = require("../lib/business-invitation-record");
const business_lifecycle_emails_1 = require("../lib/business-lifecycle-emails");
const pool_1 = require("../db/pool");
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
    const businessTimingStatus = evaluation.status;
    const needsReview = evaluation.status === "needs_forkup_review" &&
        (Boolean(body.launch) || Boolean(body.submitForForkupReview));
    if (needsReview) {
        return {
            businessTimingStatus,
            forkupReviewStatus: "pending",
            forkupReviewReason: evaluation.message ||
                "Campaign submitted for ForkUp review (short business-method timeline).",
            forkupReviewRequestedAt: new Date(),
        };
    }
    return {
        businessTimingStatus,
        forkupReviewStatus: "none",
        forkupReviewReason: null,
        forkupReviewRequestedAt: null,
    };
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
async function upsertNewBusinessInvite(connection, params) {
    const { campaignId, nonprofitId, methodId, invite, existingPartnerKeys, existingPartnerEmails, startOrEventDate, invitedByUserId, } = params;
    const email = invite.businessEmail.trim().toLowerCase();
    const name = invite.businessName.trim();
    if (!email.includes("@") || !name)
        return false;
    if (existingPartnerEmails.has(email))
        return false;
    const { rows: existingCbl } = await connection.query(`SELECT cbl.id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     WHERE cbl.campaign_id = $1 AND LOWER(b.contact_email) = $2
     LIMIT 1`, [campaignId, email]);
    if (existingCbl.length > 0) {
        existingPartnerEmails.add(email);
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
    const partnerKey = `${businessId}:${locationId}`;
    if (existingPartnerKeys.has(partnerKey)) {
        existingPartnerEmails.add(email);
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
    existingPartnerEmails.add(email);
    return true;
}
async function linkUserToNonprofit(connection, userId, nonprofitId) {
    await connection.query(`INSERT INTO organization_users (organization_type, organization_id, user_id, role)
     VALUES ('nonprofit', $1, $2, 'admin')
     ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`, [nonprofitId, userId]);
}
exports.builderRouter.get("/businesses", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
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
         bl.state
       FROM businesses b
       JOIN business_locations bl ON bl.business_id = b.id
       ${where}
       ORDER BY b.business_name, bl.location_name`, params);
        const grouped = new Map();
        for (const row of rows) {
            const capabilities = Object.keys(methods_1.METHOD_CAPABILITY).filter((m) => businessSupportsMethod(row, m));
            if (!grouped.has(row.id)) {
                grouped.set(row.id, {
                    id: row.id,
                    businessName: row.business_name,
                    businessType: row.business_type ?? "Business",
                    defaultGivebackPercentage: Number(row.default_giveback_percentage ?? 10),
                    capabilities,
                    locations: [],
                });
            }
            grouped.get(row.id).locations.push({
                id: row.location_id,
                locationName: row.location_name,
                city: row.city ?? "",
                state: row.state ?? "",
            });
        }
        res.json([...grouped.values()]);
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
              c.campaign_start_date, c.campaign_end_date, c.cover_image_url, c.campaign_status
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
            status: campaign.campaign_status,
            origin: originRows.length > 0 ? "business_invite" : "nonprofit",
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
        if (body.launch && !body.termsAccepted) {
            res.status(400).json({ error: "Terms must be accepted before launch" });
            return;
        }
        const timingEval = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
            methods: methodsForSave,
            startDate: body.startDate,
            eventDate: body.eventDate,
        });
        const timingFields = timingFieldsFromEvaluation(timingEval, body);
        await connection.query("BEGIN");
        const { rows: campaigns } = await connection.query("SELECT id, campaign_status, nonprofit_id FROM campaigns WHERE slug = $1", [slug]);
        if (campaigns.length === 0) {
            await connection.query("ROLLBACK");
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(campaigns[0].id);
        const nonprofitId = Number(campaigns[0].nonprofit_id);
        const currentStatus = campaigns[0].campaign_status;
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (authUser)
            await linkUserToNonprofit(connection, authUser.id, nonprofitId);
        if (!["draft", "ready_to_launch", "in_review"].includes(currentStatus) &&
            !body.launch) {
            res.status(400).json({ error: "This campaign can no longer be edited" });
            return;
        }
        const needsBusiness = (0, methods_1.requiresAnyBusiness)(methodsForSave);
        const resolvedStartDate = resolveStartDate(body, methodsForSave);
        const resolvedEndDate = (0, date_only_1.toDateOnlyString)(body.endDate);
        const resolvedEventDate = (0, date_only_1.toDateOnlyString)(body.eventDate);
        const { rows: existingPartners } = await connection.query(`SELECT cbl.business_id, cbl.location_id, LOWER(b.contact_email) AS contact_email
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       WHERE cbl.campaign_id = $1`, [campaignId]);
        const existingPartnerKeys = new Set(existingPartners.map((p) => `${p.business_id}:${p.location_id}`));
        const existingPartnerEmails = new Set(existingPartners
            .map((p) => (p.contact_email ? String(p.contact_email) : ""))
            .filter(Boolean));
        const newInvitationCount = (body.invitations?.filter((inv) => !existingPartnerKeys.has(`${inv.businessId}:${inv.locationId}`)).length ?? 0) + (body.newBusinessInvites?.length ?? 0);
        const canInviteBusinessesEarly = timingFields.businessTimingStatus === "ok";
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
        let nextStatus = body.launch
            ? submitLaunchForReview
                ? "in_review"
                : await resolveLaunchStatus(connection, campaignId, resolvedStartDate ?? undefined, methodsForSave)
            : currentStatus === "ready_to_launch"
                ? "ready_to_launch"
                : currentStatus === "in_review"
                    ? "in_review"
                    : "draft";
        await connection.query(`UPDATE campaigns SET
        campaign_name = $1,
        campaign_story = $2,
        campaign_goal = $3,
        campaign_start_date = $4,
        campaign_end_date = $5,
        event_date = $6,
        cover_image_url = $7,
        invitation_deadline = $8,
        campaign_status = $9,
        terms_accepted = $10,
        terms_accepted_at = CASE WHEN $11 THEN NOW() ELSE terms_accepted_at END,
        business_timing_status = $12,
        forkup_review_status = CASE
          WHEN $13 = 'pending' THEN 'pending'
          WHEN forkup_review_status = 'approved' THEN 'approved'
          ELSE $13
        END,
        forkup_review_reason = COALESCE($14, forkup_review_reason),
        forkup_review_requested_at = CASE
          WHEN $13 = 'pending' THEN COALESCE(forkup_review_requested_at, NOW())
          ELSE forkup_review_requested_at
        END,
        updated_at = NOW()
       WHERE id = $15`, [
            body.campaignName.trim(),
            body.campaignStory.trim(),
            body.campaignGoal ?? 0,
            resolvedStartDate,
            resolvedEndDate,
            resolvedEventDate,
            body.coverImage,
            invitationDeadline,
            nextStatus,
            body.termsAccepted,
            body.termsAccepted,
            timingFields.businessTimingStatus,
            timingFields.forkupReviewStatus,
            timingFields.forkupReviewReason,
            campaignId,
        ]);
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
        const canInviteBusinesses = timingFields.businessTimingStatus === "ok";
        const inviteAnchorDate = resolvedEventDate || resolvedStartDate || resolvedEndDate;
        const invitedByUserId = authUser?.id ?? null;
        if (canInviteBusinesses) {
            for (const invite of body.invitations ?? []) {
                const key = `${invite.businessId}:${invite.locationId}`;
                if (existingPartnerKeys.has(key))
                    continue;
                const methodId = methodIdByType.get(invite.methodType);
                if (!methodId)
                    continue;
                const { rows: bizRows } = await connection.query(`SELECT b.*, bl.id AS location_id
           FROM businesses b
           JOIN business_locations bl ON bl.business_id = b.id
           WHERE b.id = $1 AND bl.id = $2`, [invite.businessId, invite.locationId]);
                if (bizRows.length === 0)
                    continue;
                const biz = bizRows[0];
                if (!businessSupportsMethod(biz, invite.methodType))
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
        if (!body.nonprofit?.organizationName?.trim()) {
            res.status(400).json({ error: "Organization name is required" });
            return;
        }
        if (!body.nonprofit.contactEmail?.includes("@")) {
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
        if (body.launch && !body.termsAccepted) {
            res.status(400).json({ error: "Terms must be accepted before launch" });
            return;
        }
        const timingEval = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
            methods: methodsForSave,
            startDate: body.startDate,
            eventDate: body.eventDate,
        });
        const timingFields = timingFieldsFromEvaluation(timingEval, body);
        const hasInvitations = (body.invitations?.length ?? 0) + (body.newBusinessInvites?.length ?? 0) > 0;
        const needsBusiness = (0, methods_1.requiresAnyBusiness)(methodsForSave);
        const resolvedStartDate = resolveStartDate(body, methodsForSave);
        const resolvedEndDate = (0, date_only_1.toDateOnlyString)(body.endDate);
        const resolvedEventDate = (0, date_only_1.toDateOnlyString)(body.eventDate);
        const canInviteBusinesses = timingFields.businessTimingStatus === "ok";
        if (needsBusiness && body.launch && !hasInvitations && canInviteBusinesses) {
            res.status(400).json({
                error: "At least one business location must be invited for the selected methods",
            });
            return;
        }
        await connection.query("BEGIN");
        const email = body.nonprofit.contactEmail.trim().toLowerCase();
        const orgSlug = body.nonprofit.organizationName
            .toLowerCase()
            .replace(/[^\w]+/g, "-")
            .replace(/^-|-$/g, "");
        const { rows: existingNp } = await connection.query("SELECT id FROM nonprofits WHERE contact_email = $1 OR slug = $2", [email, orgSlug]);
        let nonprofitId;
        if (existingNp.length > 0) {
            nonprofitId = Number(existingNp[0].id);
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
                body.nonprofit.contactName?.trim() ?? body.nonprofit.organizationName.trim(),
                email,
                body.nonprofit.mission ?? null,
                body.nonprofit.causeCategory ?? null,
                nonprofitId,
            ]);
        }
        else {
            const { rows: npResult } = await connection.query(`INSERT INTO nonprofits (
          organization_name, slug, mission, cause_category,
          contact_name, contact_email, verification_status, claim_status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'unclaimed', 'claimed') RETURNING id`, [
                body.nonprofit.organizationName.trim(),
                orgSlug,
                body.nonprofit.mission ?? null,
                body.nonprofit.causeCategory ?? null,
                body.nonprofit.contactName?.trim() ?? body.nonprofit.organizationName.trim(),
                email,
            ]);
            nonprofitId = npResult[0].id;
        }
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (authUser)
            await linkUserToNonprofit(connection, authUser.id, nonprofitId);
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
        invitation_deadline, terms_accepted, terms_accepted_at,
        business_timing_status, forkup_review_status, forkup_review_reason,
        forkup_review_requested_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
            body.coverImage,
            invitationDeadline,
            body.termsAccepted,
            body.termsAccepted ? new Date() : null,
            timingFields.businessTimingStatus,
            timingFields.forkupReviewStatus,
            timingFields.forkupReviewReason,
            timingFields.forkupReviewRequestedAt,
        ]);
        const campaignId = campResult[0].id;
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
        if (canInviteBusinesses) {
            for (const invite of body.invitations ?? []) {
                const methodId = methodIdByType.get(invite.methodType);
                if (!methodId)
                    continue;
                const { rows: bizRows } = await connection.query(`SELECT b.*, bl.id AS location_id
           FROM businesses b
           JOIN business_locations bl ON bl.business_id = b.id
           WHERE b.id = $1 AND bl.id = $2`, [invite.businessId, invite.locationId]);
                if (bizRows.length === 0)
                    continue;
                const biz = bizRows[0];
                if (!businessSupportsMethod(biz, invite.methodType))
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
                existingPartnerKeys.add(`${invite.businessId}:${invite.locationId}`);
                if (biz.contact_email) {
                    existingPartnerEmails.add(String(biz.contact_email).trim().toLowerCase());
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
            businessTimingStatus: timingFields.businessTimingStatus,
            forkupReviewStatus: timingFields.forkupReviewStatus,
            timing: timingEval,
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
//# sourceMappingURL=builder.js.map