"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.campaignsRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const date_only_1 = require("../lib/date-only");
const s3_1 = require("../lib/s3");
exports.campaignsRouter = (0, express_1.Router)();
function toDateInput(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value;
    const parsed = new Date(`${value}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function formatDateRange(start, end) {
    const startDate = toDateInput(start);
    const endDate = toDateInput(end);
    if (!startDate || !endDate)
        return "Dates TBD";
    const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${fmt(startDate)} – ${fmt(endDate)}`;
}
function ctaForMethod(methodType, reservationUrl) {
    if (methodType === "shop_and_donate")
        return "shop";
    if (methodType === "service_giveback")
        return "book";
    if (methodType === "guest_bartending_event")
        return "attend";
    if (reservationUrl)
        return "reserve";
    return "visit";
}
function participationMethodLabel(methodType) {
    const labels = {
        dine_and_donate: "Dine & Donate",
        shop_and_donate: "Shop & Donate",
        service_giveback: "Service Giveback",
        virtual_donations: "Virtual Donations",
        ambassador_fundraising: "Ambassador Fundraising",
        guest_bartending_event: "Guest Bartender",
    };
    return labels[methodType];
}
function mapLocation(row) {
    return {
        businessId: row.business_id,
        locationId: row.location_id,
        methodId: row.method_id,
        businessName: row.business_name,
        businessType: row.business_type ?? "Business",
        locationName: row.location_name,
        city: row.city ?? "",
        state: row.state ?? "",
        givebackPercentage: Number(row.giveback_percentage),
        participationHours: row.participation_hours,
        participationMethod: participationMethodLabel(row.method_type),
        cta: ctaForMethod(row.method_type, row.reservation_url),
        reservationUrl: row.reservation_url,
        acceptanceStatus: row.acceptance_status,
    };
}
async function mapListItem(row, locationCount) {
    return {
        slug: row.slug,
        name: row.campaign_name,
        nonprofit: row.organization_name,
        nonprofitVerified: row.verification_status === "verified",
        image: await (0, s3_1.resolveStoredImageUrl)(row.cover_image_url),
        dateRange: formatDateRange(row.campaign_start_date, row.campaign_end_date),
        raised: Number(row.raised),
        goal: Number(row.campaign_goal),
        supportersGoing: Number(row.supporters_going),
        expectedGuests: Number(row.expected_guests),
        verifiedVisits: Number(row.verified_visits),
        topEvent: Boolean(row.top_event),
        campaignStatus: row.campaign_status,
        participatingLocationCount: locationCount,
    };
}
async function fetchMethods(campaignId) {
    const { rows: rows } = await pool_1.pool.query(`SELECT id, method_type, method_name, method_status, requires_business_acceptance
     FROM campaign_methods WHERE campaign_id = $1 ORDER BY id`, [campaignId]);
    return rows.map((row) => ({
        id: row.id,
        methodType: row.method_type,
        methodName: row.method_name,
        methodStatus: row.method_status,
        requiresBusinessAcceptance: Boolean(row.requires_business_acceptance),
    }));
}
async function fetchAcceptedLocations(campaignId) {
    const { rows: rows } = await pool_1.pool.query(`SELECT
       b.id AS business_id,
       bl.id AS location_id,
       cm.id AS method_id,
       b.business_name,
       b.business_type,
       bl.location_name,
       bl.city,
       bl.state,
       cbl.giveback_percentage,
       cbl.participation_hours,
       bl.reservation_url,
       cbl.acceptance_status,
       cm.method_type
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN business_locations bl ON bl.id = cbl.location_id
     JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1
       AND cbl.acceptance_status IN ('accepted', 'live', 'completed')
     ORDER BY b.business_name, bl.location_name`, [campaignId]);
    return rows.map(mapLocation);
}
async function fetchLocationCount(campaignId) {
    const { rows: rows } = await pool_1.pool.query(`SELECT COUNT(*) AS count FROM campaign_business_locations
     WHERE campaign_id = $1 AND acceptance_status IN ('accepted', 'live', 'completed')`, [campaignId]);
    return Number(rows[0].count);
}
async function fetchCampaignBySlug(slug, options) {
    const { rows: campaigns } = await pool_1.pool.query(`SELECT c.*, n.organization_name, n.verification_status
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.slug = $1`, [slug]);
    if (campaigns.length === 0)
        return null;
    const campaign = campaigns[0];
    if (options?.publicOnly) {
        const status = String(campaign.campaign_status);
        if (status !== "live" && status !== "closed" && status !== "ready_to_launch")
            return null;
    }
    const [methods, locations] = await Promise.all([
        fetchMethods(campaign.id),
        fetchAcceptedLocations(campaign.id),
    ]);
    return {
        ...(await mapListItem(campaign, locations.length)),
        description: campaign.campaign_story,
        methods,
        participatingLocations: locations,
        eventDate: (0, date_only_1.toDateOnlyString)(campaign.event_date),
        featuredYoutubeUrl: campaign.featured_youtube_url != null &&
            String(campaign.featured_youtube_url).trim()
            ? String(campaign.featured_youtube_url).trim()
            : null,
    };
}
exports.campaignsRouter.get("/", async (req, res) => {
    try {
        const status = req.query.status;
        await pool_1.pool.query(`UPDATE campaigns SET campaign_status = 'live', updated_at = NOW()
       WHERE campaign_status = 'ready_to_launch'
         AND campaign_start_date IS NOT NULL
         AND campaign_start_date <= CURRENT_DATE`);
        const whereClause = status
            ? "WHERE c.campaign_status = $1"
            : "WHERE c.campaign_status = 'live'";
        const params = status ? [status] : [];
        const { rows: campaigns } = await pool_1.pool.query(`SELECT c.*, n.organization_name, n.verification_status
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       ${whereClause}
       ORDER BY c.top_event DESC, c.raised DESC`, params);
        const results = await Promise.all(campaigns.map(async (campaign) => {
            const locationCount = await fetchLocationCount(campaign.id);
            return mapListItem(campaign, locationCount);
        }));
        res.json(results);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch campaigns" });
    }
});
exports.campaignsRouter.get("/:slug/donations", async (req, res) => {
    try {
        const { rows: campaigns } = await pool_1.pool.query(`SELECT id, campaign_status FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const status = String(campaign.campaign_status);
        if (status !== "live" && status !== "closed") {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(campaign.id);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const { rows: countRows } = await pool_1.pool.query(`SELECT COUNT(*) AS count FROM (
         SELECT d.id
         FROM donations d
         WHERE d.campaign_id = $1
           AND d.payment_status = 'completed'
           AND d.donation_type = 'virtual'
         UNION ALL
         SELECT r.id
         FROM receipts r
         WHERE r.campaign_id = $1
           AND r.review_status = 'approved'
       ) feed_items`, [campaignId]);
        const { rows: donations } = await pool_1.pool.query(`SELECT amount, notes, created_at, first_name
       FROM (
         SELECT d.amount, d.notes, d.created_at, s.first_name
         FROM donations d
         LEFT JOIN supporters s ON s.id = d.supporter_id
         WHERE d.campaign_id = $1
           AND d.payment_status = 'completed'
           AND d.donation_type = 'virtual'
         UNION ALL
         SELECT
           COALESCE(r.calculated_donation, 0) AS amount,
           NULL AS notes,
           COALESCE(r.approved_at, r.uploaded_at) AS created_at,
           s.first_name
         FROM receipts r
         LEFT JOIN supporters s ON s.id = r.supporter_id
         WHERE r.campaign_id = $1
           AND r.review_status = 'approved'
       ) feed
       ORDER BY created_at DESC
       LIMIT $2`, [campaignId, limit]);
        res.json({
            totalCount: Number(countRows[0]?.count ?? 0),
            donations: donations.map((row) => {
                const anonymous = row.notes === "anonymous";
                const donorName = anonymous || !row.first_name ? "Anonymous" : String(row.first_name);
                return {
                    donorName,
                    amount: Number(row.amount),
                    createdAt: row.created_at,
                    anonymous,
                };
            }),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch donations" });
    }
});
exports.campaignsRouter.get("/:slug/leaderboard", async (req, res) => {
    try {
        const { rows: campaigns } = await pool_1.pool.query(`SELECT id, campaign_status FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const status = String(campaign.campaign_status);
        if (status !== "live" && status !== "closed") {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(campaign.id);
        const clampLimit = (raw, fallback) => Math.min(50, Math.max(1, Number(raw) || fallback));
        const fundraisersLimit = clampLimit(req.query.fundraisersLimit, 5);
        const donorsLimit = clampLimit(req.query.donorsLimit, 5);
        const { rows: fundraiserCountRows } = await pool_1.pool.query(`SELECT COUNT(*) AS count
       FROM campaign_participants
       WHERE campaign_id = $1
         AND participant_type = 'ambassador'
         AND leaderboard_enabled = TRUE
         AND status IN ('active', 'completed')`, [campaignId]);
        const { rows: fundraiserRows } = await pool_1.pool.query(`SELECT
         cp.name,
         COALESCE(SUM(d.amount), 0) AS raised,
         COUNT(d.id)::int AS donation_count
       FROM campaign_participants cp
       LEFT JOIN donations d
         ON d.campaign_id = cp.campaign_id
        AND d.payment_status = 'completed'
        AND d.donation_type = 'virtual'
        AND d.attribution_code IS NOT NULL
        AND d.attribution_code = cp.tracking_code
       WHERE cp.campaign_id = $1
         AND cp.participant_type = 'ambassador'
         AND cp.leaderboard_enabled = TRUE
         AND cp.status IN ('active', 'completed')
       GROUP BY cp.id, cp.name
       ORDER BY raised DESC, cp.name ASC
       LIMIT $2`, [campaignId, fundraisersLimit]);
        const { rows: donorCountRows } = await pool_1.pool.query(`SELECT COUNT(*) AS count FROM (
         SELECT supporter_id FROM (
           SELECT d.supporter_id
           FROM donations d
           WHERE d.campaign_id = $1
             AND d.payment_status = 'completed'
             AND d.donation_type = 'virtual'
             AND d.supporter_id IS NOT NULL
           UNION
           SELECT r.supporter_id
           FROM receipts r
           WHERE r.campaign_id = $1
             AND r.review_status = 'approved'
             AND r.supporter_id IS NOT NULL
         ) all_donor_ids
       ) donor_groups`, [campaignId]);
        const { rows: donorRows } = await pool_1.pool.query(`SELECT
         supporter_id,
         BOOL_OR(any_anonymous) AS any_anonymous,
         MAX(first_name) AS first_name,
         SUM(amount) AS total_amount,
         SUM(item_count)::int AS donation_count,
         MAX(occurred_at) AS last_at
       FROM (
         SELECT
           d.supporter_id,
           (d.notes = 'anonymous') AS any_anonymous,
           s.first_name,
           d.amount,
           1 AS item_count,
           d.created_at AS occurred_at
         FROM donations d
         LEFT JOIN supporters s ON s.id = d.supporter_id
         WHERE d.campaign_id = $1
           AND d.payment_status = 'completed'
           AND d.donation_type = 'virtual'
           AND d.supporter_id IS NOT NULL
         UNION ALL
         SELECT
           r.supporter_id,
           FALSE AS any_anonymous,
           s.first_name,
           COALESCE(r.calculated_donation, 0) AS amount,
           1 AS item_count,
           COALESCE(r.approved_at, r.uploaded_at) AS occurred_at
         FROM receipts r
         LEFT JOIN supporters s ON s.id = r.supporter_id
         WHERE r.campaign_id = $1
           AND r.review_status = 'approved'
           AND r.supporter_id IS NOT NULL
       ) combined
       GROUP BY supporter_id
       ORDER BY total_amount DESC, last_at DESC
       LIMIT $2`, [campaignId, donorsLimit]);
        res.json({
            fundraisersTotalCount: Number(fundraiserCountRows[0]?.count ?? 0),
            donorsTotalCount: Number(donorCountRows[0]?.count ?? 0),
            fundraisers: fundraiserRows.map((row) => ({
                name: String(row.name),
                raised: Number(row.raised),
                donationCount: Number(row.donation_count ?? 0),
            })),
            donors: donorRows.map((row) => {
                const anonymous = Boolean(row.any_anonymous) || !row.first_name;
                return {
                    donorName: anonymous ? "Anonymous" : String(row.first_name),
                    totalAmount: Number(row.total_amount),
                    donationCount: Number(row.donation_count ?? 0),
                    anonymous,
                };
            }),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
});
exports.campaignsRouter.post("/:slug/donations", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const { amount, donorName, email, anonymous, attributionCode } = req.body;
        const donationAmount = Number(amount);
        if (!Number.isFinite(donationAmount) || donationAmount < 1) {
            res.status(400).json({ error: "Valid donation amount is required" });
            return;
        }
        if (!email || typeof email !== "string" || !email.includes("@")) {
            res.status(400).json({ error: "Valid email is required" });
            return;
        }
        const { rows: campaigns } = await connection.query(`SELECT id, campaign_status FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const status = String(campaign.campaign_status);
        if (status !== "live") {
            res.status(400).json({ error: "This campaign is not accepting donations yet" });
            return;
        }
        const campaignId = Number(campaign.id);
        const normalizedEmail = email.trim().toLowerCase();
        const displayName = anonymous || !donorName || typeof donorName !== "string"
            ? "Anonymous"
            : donorName.trim();
        await connection.query("BEGIN");
        const { rows: existingSupporters } = await connection.query("SELECT id FROM supporters WHERE email = $1", [normalizedEmail]);
        let supporterId;
        if (existingSupporters.length > 0) {
            supporterId = Number(existingSupporters[0].id);
        }
        else {
            const { rows: supporterResult } = await connection.query("INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id", [displayName, normalizedEmail]);
            supporterId = supporterResult[0].id;
        }
        const { rows: methods } = await connection.query(`SELECT id FROM campaign_methods
       WHERE campaign_id = $1 AND method_type = 'virtual_donations' LIMIT 1`, [campaignId]);
        const methodId = methods.length > 0 ? Number(methods[0].id) : null;
        await connection.query(`INSERT INTO donations (
        campaign_id, method_id, supporter_id, amount, donation_type,
        payment_status, attribution_code, notes
      ) VALUES ($1, $2, $3, $4, 'virtual', 'completed', $5, $6)`, [
            campaignId,
            methodId,
            supporterId,
            donationAmount,
            typeof attributionCode === "string" ? attributionCode : null,
            anonymous ? "anonymous" : null,
        ]);
        await connection.query(`UPDATE campaigns SET raised = raised + $1, updated_at = NOW() WHERE id = $2`, [Math.round(donationAmount), campaignId]);
        const { rows: updated } = await connection.query("SELECT raised FROM campaigns WHERE id = $1", [campaignId]);
        await connection.query("COMMIT");
        res.status(201).json({
            success: true,
            amount: donationAmount,
            raised: Number(updated[0].raised),
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to record donation" });
    }
    finally {
        connection.release();
    }
});
exports.campaignsRouter.post("/:slug/participate", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const { firstName, email, partySize, isFirstVisit, businessId, locationId, methodId } = req.body;
        if (!firstName || typeof firstName !== "string" || !firstName.trim()) {
            res.status(400).json({ error: "First name is required" });
            return;
        }
        if (!email || typeof email !== "string" || !email.includes("@")) {
            res.status(400).json({ error: "Valid email is required" });
            return;
        }
        const guests = Number(partySize);
        if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
            res.status(400).json({ error: "Party size must be between 1 and 50" });
            return;
        }
        const bizId = Number(businessId);
        const locId = Number(locationId);
        const methId = Number(methodId);
        if (!bizId || !locId || !methId) {
            res.status(400).json({ error: "Business, location, and method are required" });
            return;
        }
        const { rows: campaigns } = await connection.query("SELECT id FROM campaigns WHERE slug = $1 AND campaign_status = 'live'", [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found or not live" });
            return;
        }
        const campaignId = Number(campaigns[0].id);
        const { rows: locations } = await connection.query(`SELECT
         b.id AS business_id,
         bl.id AS location_id,
         cm.id AS method_id,
         b.business_name,
         b.business_type,
         bl.location_name,
         bl.city,
         bl.state,
         cbl.giveback_percentage,
         cbl.participation_hours,
         bl.reservation_url,
         cbl.acceptance_status,
         cm.method_type
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1
         AND cbl.business_id = $2
         AND cbl.location_id = $3
         AND cbl.method_id = $4
         AND cbl.acceptance_status IN ('accepted', 'live', 'completed')`, [campaignId, bizId, locId, methId]);
        if (locations.length === 0) {
            res.status(400).json({ error: "Selected location is not part of this campaign" });
            return;
        }
        const location = locations[0];
        const participationPath = location.reservation_url ? "reservation" : "walk_in";
        const normalizedEmail = email.trim().toLowerCase();
        await connection.query("BEGIN");
        const { rows: existingSupporters } = await connection.query("SELECT id FROM supporters WHERE email = $1", [normalizedEmail]);
        let supporterId;
        if (existingSupporters.length > 0) {
            supporterId = Number(existingSupporters[0].id);
        }
        else {
            const { rows: supporterResult } = await connection.query("INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id", [firstName.trim(), normalizedEmail]);
            supporterId = supporterResult[0].id;
        }
        await connection.query(`INSERT INTO participation_intents (
        campaign_id, method_id, business_id, location_id, supporter_id,
        party_size, is_first_visit, participation_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            campaignId,
            methId,
            bizId,
            locId,
            supporterId,
            guests,
            Boolean(isFirstVisit),
            participationPath,
        ]);
        await connection.query(`UPDATE campaigns
       SET supporters_going = supporters_going + 1,
           expected_guests = expected_guests + $1
       WHERE id = $2`, [guests, campaignId]);
        const { rows: updated } = await connection.query("SELECT supporters_going, expected_guests FROM campaigns WHERE id = $1", [campaignId]);
        await connection.query("COMMIT");
        res.status(201).json({
            success: true,
            participationPath,
            reservationUrl: location.reservation_url,
            businessName: location.business_name,
            locationName: location.location_name,
            supportersGoing: Number(updated[0].supporters_going),
            expectedGuests: Number(updated[0].expected_guests),
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to record participation" });
    }
    finally {
        connection.release();
    }
});
exports.campaignsRouter.get("/:slug", async (req, res) => {
    try {
        await pool_1.pool.query(`UPDATE campaigns SET campaign_status = 'live', updated_at = NOW()
       WHERE slug = $1
         AND campaign_status = 'ready_to_launch'
         AND campaign_start_date IS NOT NULL
         AND campaign_start_date <= CURRENT_DATE`, [req.params.slug]);
        const campaign = await fetchCampaignBySlug(req.params.slug, { publicOnly: true });
        if (!campaign) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        res.json(campaign);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch campaign" });
    }
});
//# sourceMappingURL=campaigns.js.map