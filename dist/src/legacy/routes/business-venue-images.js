"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessVenueImagesRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const business_venue_images_1 = require("../lib/business-venue-images");
const persist_business_public_links_1 = require("../lib/persist-business-public-links");
exports.businessVenueImagesRouter = (0, express_1.Router)();
function parseStoredGallery(raw) {
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
exports.businessVenueImagesRouter.post("/business-venue-images", async (req, res) => {
    try {
        const websiteUrl = typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
        if (!websiteUrl) {
            res.status(400).json({ error: "websiteUrl is required." });
            return;
        }
        const reservationUrl = typeof req.body?.reservationUrl === "string"
            ? req.body.reservationUrl.trim()
            : "";
        const businessIdRaw = Number(req.body?.businessId);
        const businessId = Number.isFinite(businessIdRaw) && businessIdRaw > 0 ? businessIdRaw : null;
        if (businessId) {
            try {
                const { rows } = await pool_1.pool.query(`SELECT venue_gallery_urls, venue_cover_url FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
                const cached = parseStoredGallery(rows[0]?.venue_gallery_urls);
                if (cached.length > 0) {
                    const coverUrl = rows[0]?.venue_cover_url?.trim() || null;
                    res.json({
                        imageUrls: cached,
                        reservationUrl: reservationUrl || null,
                        coverUrl,
                    });
                    return;
                }
            }
            catch {
            }
        }
        const imageUrls = await (0, business_venue_images_1.scrapeBusinessVenueImages)({
            websiteUrl,
            reservationUrl: reservationUrl || null,
            limit: 16,
        });
        if (businessId && imageUrls.length > 0) {
            void (0, persist_business_public_links_1.persistBusinessGalleryUrls)(businessId, imageUrls);
        }
        res.json({
            imageUrls,
            reservationUrl: reservationUrl || null,
            coverUrl: null,
        });
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to scrape venue images";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=business-venue-images.js.map