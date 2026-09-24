"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessVenueLinksRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const persist_business_public_links_1 = require("../lib/persist-business-public-links");
const pool_1 = require("../db/pool");
exports.businessVenueLinksRouter = (0, express_1.Router)();
function optionalString(raw) {
    if (raw === undefined)
        return undefined;
    if (raw === null)
        return null;
    if (typeof raw !== "string")
        return undefined;
    return raw;
}
exports.businessVenueLinksRouter.post("/business-venue-links", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in required." });
            return;
        }
        const businessIdRaw = Number(req.body?.businessId);
        const businessId = Number.isFinite(businessIdRaw) && businessIdRaw > 0 ? businessIdRaw : null;
        if (!businessId) {
            res.status(400).json({ error: "businessId is required." });
            return;
        }
        if (!(0, campaign_partner_join_requests_1.userBelongsToBusiness)(user, businessId)) {
            res.status(403).json({ error: "Not authorized for this business." });
            return;
        }
        const body = req.body ?? {};
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, "website")) {
            patch.website = optionalString(body.website) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "facebookUrl")) {
            patch.facebookUrl = optionalString(body.facebookUrl) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "instagramUrl")) {
            patch.instagramUrl = optionalString(body.instagramUrl) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "linkedinUrl")) {
            patch.linkedinUrl = optionalString(body.linkedinUrl) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "tiktokUrl")) {
            patch.tiktokUrl = optionalString(body.tiktokUrl) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "phone")) {
            patch.phone = optionalString(body.phone) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "venueEmail")) {
            patch.venueEmail = optionalString(body.venueEmail) ?? null;
        }
        if (Object.keys(patch).length === 0) {
            const { rows } = await pool_1.pool.query(`SELECT website, facebook_url, instagram_url, linkedin_url, tiktok_url,
                contact_phone, venue_email
         FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
            const row = rows[0];
            res.json({
                website: row?.website?.trim() || null,
                facebookUrl: row?.facebook_url?.trim() || null,
                instagramUrl: row?.instagram_url?.trim() || null,
                linkedinUrl: row?.linkedin_url?.trim() || null,
                tiktokUrl: row?.tiktok_url?.trim() || null,
                phone: row?.contact_phone?.trim() || null,
                venueEmail: row?.venue_email?.trim() || null,
            });
            return;
        }
        const written = await (0, persist_business_public_links_1.updateBusinessPublicLinks)(businessId, patch);
        if (written == null) {
            res.status(500).json({ error: "Failed to save venue links." });
            return;
        }
        res.json(written);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to save venue links";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=business-venue-links.js.map