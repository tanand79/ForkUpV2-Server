"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promoteFundraiserDraftOnAccept = promoteFundraiserDraftOnAccept;
const invitations_1 = require("./invitations");
const date_only_1 = require("./date-only");
const campaign_timing_1 = require("./campaign-timing");
function isStartDateReached(startDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return start.getTime() <= today.getTime();
}
async function resolveLaunchStatus(connection, campaignId, startDate) {
    const { rows: methods } = await connection.query(`SELECT requires_business_acceptance
     FROM campaign_methods WHERE campaign_id = $1`, [campaignId]);
    const hasDefaultFundraisingLayer = methods.some((m) => !Boolean(m.requires_business_acceptance));
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
    const start = startDate ? (0, date_only_1.toDateOnlyString)(startDate) : null;
    if (start && isStartDateReached(start))
        return "live";
    return "ready_to_launch";
}
async function promoteFundraiserDraftOnAccept(connection, campaignId, startDate) {
    const { rows } = await connection.query(`SELECT campaign_status, campaign_start_date, event_date,
            forkup_review_status, business_timing_status,
            confirmed_business_name, confirmed_contact_name,
            confirmed_contact_email, confirmed_method, confirmed_status
     FROM campaigns WHERE id = $1`, [campaignId]);
    if (rows.length === 0) {
        return "draft";
    }
    const current = String(rows[0].campaign_status);
    if (current === "in_review") {
        return "in_review";
    }
    if (current !== "draft") {
        return current;
    }
    const start = (0, date_only_1.toDateOnlyString)(startDate) ??
        (0, date_only_1.toDateOnlyString)(rows[0].campaign_start_date);
    const eventDate = (0, date_only_1.toDateOnlyString)(rows[0].event_date);
    const forkupStatus = String(rows[0].forkup_review_status ?? "none");
    const businessTiming = String(rows[0].business_timing_status ?? "ok");
    const businessConfirmed = (0, campaign_timing_1.isBusinessConfirmationComplete)({
        confirmedBusinessName: rows[0].confirmed_business_name,
        confirmedContactName: rows[0].confirmed_contact_name,
        confirmedContactEmail: rows[0].confirmed_contact_email,
        confirmedMethod: rows[0].confirmed_method,
        confirmedStatus: rows[0].confirmed_status,
    });
    const { rows: methodRows } = await connection.query(`SELECT method_type FROM campaign_methods WHERE campaign_id = $1`, [campaignId]);
    const methodTypes = methodRows.map((r) => String(r.method_type));
    const timingEval = (0, campaign_timing_1.evaluateBusinessMethodTiming)({
        methods: methodTypes,
        startDate: start,
        eventDate,
    });
    if (timingEval.status === "too_soon" || businessTiming === "too_soon") {
        return "draft";
    }
    const tightUnresolved = (timingEval.status === "tight_timeline" ||
        businessTiming === "tight_timeline") &&
        !businessConfirmed &&
        forkupStatus !== "pending" &&
        forkupStatus !== "changes_requested" &&
        businessTiming !== "needs_forkup_review";
    if (tightUnresolved) {
        return "draft";
    }
    const needsForkupReview = timingEval.status === "needs_forkup_review" ||
        businessTiming === "needs_forkup_review" ||
        forkupStatus === "pending" ||
        forkupStatus === "changes_requested";
    if (needsForkupReview) {
        await connection.query(`UPDATE campaigns SET
         campaign_status = 'in_review',
         business_timing_status = CASE
           WHEN $2::text = 'needs_forkup_review' THEN 'needs_forkup_review'
           ELSE business_timing_status
         END,
         forkup_review_status = CASE
           WHEN forkup_review_status IN ('approved', 'denied') THEN forkup_review_status
           ELSE 'pending'
         END,
         forkup_review_requested_at = COALESCE(forkup_review_requested_at, NOW()),
         updated_at = NOW()
       WHERE id = $1 AND campaign_status = 'draft'`, [
            campaignId,
            timingEval.status === "needs_forkup_review" ||
                businessTiming === "needs_forkup_review"
                ? "needs_forkup_review"
                : businessTiming,
        ]);
        if (timingEval.status === "needs_forkup_review" ||
            businessTiming === "needs_forkup_review") {
            await connection.query(`UPDATE campaign_methods
         SET timing_status = 'needs_forkup_review', updated_at = NOW()
         WHERE campaign_id = $1`, [campaignId]);
        }
        return "in_review";
    }
    const nextStatus = await resolveLaunchStatus(connection, campaignId, start);
    await connection.query(`UPDATE campaigns SET campaign_status = $1, updated_at = NOW()
     WHERE id = $2 AND campaign_status = 'draft'`, [nextStatus, campaignId]);
    if (nextStatus === "live") {
        await connection.query(`UPDATE campaign_methods
       SET method_status = 'live', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`, [campaignId]);
    }
    else if (nextStatus === "ready_to_launch") {
        await connection.query(`UPDATE campaign_methods
       SET method_status = 'scheduled', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`, [campaignId]);
    }
    else {
        await connection.query(`UPDATE campaign_methods
       SET method_status = 'invited', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`, [campaignId]);
    }
    await (0, invitations_1.maybePromoteCampaignToLive)(connection, campaignId);
    const { rows: statusRows } = await connection.query(`SELECT campaign_status FROM campaigns WHERE id = $1`, [campaignId]);
    return String(statusRows[0]?.campaign_status ?? nextStatus);
}
//# sourceMappingURL=fundraiser-accept-launch.js.map