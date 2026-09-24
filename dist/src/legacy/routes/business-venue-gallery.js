"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessVenueGalleryRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const persist_business_public_links_1 = require("../lib/persist-business-public-links");
const pool_1 = require("../db/pool");
exports.businessVenueGalleryRouter = (0, express_1.Router)();
function parseGalleryUrls(raw) {
    if (!raw)
        return [];
    let value = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    if (!Array.isArray(value))
        return [];
    return value.filter((u) => typeof u === "string" && u.trim().length > 0);
}
async function loadVenueMedia(businessId) {
    const { rows } = await pool_1.pool.query(`SELECT venue_gallery_urls, venue_cover_url FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
    return {
        imageUrls: parseGalleryUrls(rows[0]?.venue_gallery_urls),
        coverUrl: rows[0]?.venue_cover_url?.trim() || null,
    };
}
exports.businessVenueGalleryRouter.post("/business-venue-gallery", async (req, res) => {
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
        const imageUrlsRaw = req.body?.imageUrls;
        const imageUrls = Array.isArray(imageUrlsRaw)
            ? imageUrlsRaw.filter((u) => typeof u === "string" && u.trim().length > 0)
            : [];
        const hasCoverField = Object.prototype.hasOwnProperty.call(req.body ?? {}, "coverUrl");
        const coverRaw = req.body?.coverUrl;
        const coverInput = typeof coverRaw === "string"
            ? coverRaw.trim() || null
            : coverRaw === null
                ? null
                : undefined;
        if (imageUrls.length === 0 && !hasCoverField) {
            const current = await loadVenueMedia(businessId);
            res.json(current);
            return;
        }
        let merged = imageUrls.length > 0
            ? await (0, persist_business_public_links_1.mergeBusinessGalleryUrls)(businessId, imageUrls)
            : (await loadVenueMedia(businessId)).imageUrls;
        let coverUrl = null;
        if (hasCoverField) {
            coverUrl = await (0, persist_business_public_links_1.persistBusinessVenueCoverUrl)(businessId, coverInput ?? null);
            if (coverUrl && !merged.includes(coverUrl)) {
                merged = await (0, persist_business_public_links_1.mergeBusinessGalleryUrls)(businessId, [coverUrl]);
            }
        }
        else {
            coverUrl = (await loadVenueMedia(businessId)).coverUrl;
        }
        res.json({ imageUrls: merged, coverUrl });
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to save venue gallery";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=business-venue-gallery.js.map