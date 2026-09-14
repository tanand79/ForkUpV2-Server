"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessPostStartRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const join_door_type_1 = require("../lib/join-door-type");
const business_post_start_checklist_1 = require("../lib/business-post-start-checklist");
exports.businessPostStartRouter = (0, express_1.Router)();
exports.businessPostStartRouter.get("/business/:businessId/post-start-checklist", async (req, res) => {
    try {
        const businessId = Number(req.params.businessId);
        if (!Number.isFinite(businessId) || businessId <= 0) {
            res.status(400).json({ error: "Valid businessId is required" });
            return;
        }
        const { rows: bizRows } = await pool_1.pool.query(`SELECT id, business_name, contact_email, claim_status, profile_status,
                join_door_type,
                supports_dine_and_donate, supports_shop_and_donate,
                supports_service_giveback, supports_guest_bartending
         FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
        if (bizRows.length === 0) {
            res.status(404).json({ error: "Business not found" });
            return;
        }
        const biz = bizRows[0];
        const { rows: locations } = await pool_1.pool.query(`SELECT city, state, ach_bank_name, ach_account_last4, ach_authorization_status
         FROM business_locations WHERE business_id = $1`, [businessId]);
        const hasRealLocation = locations.some((loc) => {
            const city = String(loc.city ?? "").trim();
            const state = String(loc.state ?? "").trim();
            return city.length > 0 && city !== "TBD" && state.length > 0 && state !== "TBD";
        });
        const hasAchSetup = locations.some((loc) => {
            const authorized = String(loc.ach_authorization_status ?? "") === "authorized";
            const hasData = Boolean(loc.ach_bank_name || loc.ach_account_last4);
            return authorized || hasData;
        });
        const { rows: accepted } = await pool_1.pool.query(`SELECT id FROM campaign_business_locations
         WHERE business_id = $1
           AND acceptance_status IN ('accepted', 'live', 'completed')
         LIMIT 1`, [businessId]);
        const hasCapability = Boolean(biz.supports_dine_and_donate) ||
            Boolean(biz.supports_shop_and_donate) ||
            Boolean(biz.supports_service_giveback) ||
            Boolean(biz.supports_guest_bartending);
        const payload = (0, business_post_start_checklist_1.buildBusinessPostStartChecklist)({
            joinDoorType: (0, join_door_type_1.normalizeJoinDoorType)(biz.join_door_type),
            businessName: biz.business_name != null ? String(biz.business_name) : null,
            contactEmail: biz.contact_email != null ? String(biz.contact_email) : null,
            claimStatus: biz.claim_status != null ? String(biz.claim_status) : null,
            profileStatus: biz.profile_status != null ? String(biz.profile_status) : null,
            locationCount: locations.length,
            hasRealLocation,
            hasCapability,
            hasAchSetup,
            hasAcceptedCampaign: accepted.length > 0,
        });
        res.json(payload);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load post-start checklist" });
    }
});
//# sourceMappingURL=business-post-start.js.map