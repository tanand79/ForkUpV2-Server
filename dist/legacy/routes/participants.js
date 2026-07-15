"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.participantsRouter = void 0;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const pool_1 = require("../db/pool");
exports.participantsRouter = (0, express_1.Router)({ mergeParams: true });
function trackingCode() {
    return crypto_1.default.randomBytes(4).toString("hex");
}
function mapParticipant(row, campaignSlug) {
    const code = row.tracking_code;
    return {
        id: row.id,
        participantType: row.participant_type,
        name: row.name,
        email: row.email,
        roleLabel: row.role_label,
        status: row.status,
        personalShareLink: row.personal_share_link,
        trackingCode: code,
        shareUrl: code ? `/campaign/${campaignSlug}?ref=${code}` : null,
        leaderboardEnabled: Boolean(row.leaderboard_enabled),
        businessId: row.business_id,
        locationId: row.location_id,
        eventDate: row.event_date,
        eventStartTime: row.event_start_time,
        eventEndTime: row.event_end_time,
        attributedDonationTotal: Number(row.attributed_donation_total ?? 0),
    };
}
async function campaignIdFromSlug(slug) {
    const { rows: rows } = await pool_1.pool.query("SELECT id FROM campaigns WHERE slug = $1", [slug]);
    return rows.length > 0 ? Number(rows[0].id) : null;
}
async function methodIdForType(campaignId, methodType) {
    const { rows: rows } = await pool_1.pool.query(`SELECT id FROM campaign_methods WHERE campaign_id = $1 AND method_type = $2 LIMIT 1`, [campaignId, methodType]);
    return rows.length > 0 ? Number(rows[0].id) : null;
}
exports.participantsRouter.get("/", async (req, res) => {
    try {
        const { slug } = req.params;
        const campaignId = await campaignIdFromSlug(slug);
        if (!campaignId) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const { rows: rows } = await pool_1.pool.query(`SELECT * FROM campaign_participants WHERE campaign_id = $1 ORDER BY created_at DESC`, [campaignId]);
        res.json(rows.map((r) => mapParticipant(r, slug)));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch participants" });
    }
});
exports.participantsRouter.post("/", async (req, res) => {
    try {
        const { slug } = req.params;
        const body = req.body;
        if (!body.name?.trim()) {
            res.status(400).json({ error: "Name is required" });
            return;
        }
        if (!body.participantType || !["ambassador", "guest_bartender"].includes(body.participantType)) {
            res.status(400).json({ error: "participantType must be ambassador or guest_bartender" });
            return;
        }
        const campaignId = await campaignIdFromSlug(slug);
        if (!campaignId) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const methodType = body.participantType === "ambassador" ? "ambassador_fundraising" : "guest_bartending_event";
        const methodId = await methodIdForType(campaignId, methodType);
        const code = trackingCode();
        const sharePath = `/campaign/${slug}?ref=${code}`;
        const { rows: result } = await pool_1.pool.query(`INSERT INTO campaign_participants (
        campaign_id, method_id, participant_type, name, email, role_label,
        status, personal_share_link, tracking_code, leaderboard_enabled,
        business_id, location_id, event_date, event_start_time, event_end_time
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, TRUE, $9, $10, $11, $12, $13) RETURNING id`, [
            campaignId,
            methodId,
            body.participantType,
            body.name.trim(),
            body.email?.trim() ?? null,
            body.roleLabel?.trim() ?? null,
            sharePath,
            code,
            body.businessId ?? null,
            body.locationId ?? null,
            body.eventDate ?? null,
            body.eventStartTime ?? null,
            body.eventEndTime ?? null,
        ]);
        const { rows: created } = await pool_1.pool.query("SELECT * FROM campaign_participants WHERE id = $1", [result[0].id]);
        res.status(201).json(mapParticipant(created[0], slug));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add participant" });
    }
});
exports.participantsRouter.delete("/:participantId", async (req, res) => {
    try {
        const { slug } = req.params;
        const campaignId = await campaignIdFromSlug(slug);
        if (!campaignId) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        await pool_1.pool.query("DELETE FROM campaign_participants WHERE id = $1 AND campaign_id = $2", [req.params.participantId, campaignId]);
        res.json({ success: true });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to remove participant" });
    }
});
//# sourceMappingURL=participants.js.map