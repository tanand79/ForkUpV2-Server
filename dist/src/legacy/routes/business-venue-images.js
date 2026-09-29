"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessVenueImagesRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const business_venue_images_1 = require("../lib/business-venue-images");
const persist_business_public_links_1 = require("../lib/persist-business-public-links");
const s3_1 = require("../lib/s3");
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
async function resolveGalleryForClient(urls) {
    return Promise.all(urls.map((u) => (0, s3_1.resolveStoredImageUrl)(u)));
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
        const forceRefresh = req.body?.forceRefresh === true;
        if (businessId && !forceRefresh) {
            try {
                const { rows } = await pool_1.pool.query(`SELECT venue_gallery_urls, venue_cover_url FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
                const cached = parseStoredGallery(rows[0]?.venue_gallery_urls);
                if (cached.length > 0) {
                    const imageUrls = await resolveGalleryForClient(cached);
                    const coverStored = rows[0]?.venue_cover_url?.trim() || null;
                    const coverUrl = coverStored
                        ? await (0, s3_1.resolveStoredImageUrl)(coverStored)
                        : imageUrls[0] ?? null;
                    res.json({
                        imageUrls,
                        reservationUrl: reservationUrl || null,
                        coverUrl,
                    });
                    return;
                }
            }
            catch {
            }
        }
        const scraped = await (0, business_venue_images_1.scrapeBusinessVenueImages)({
            websiteUrl,
            reservationUrl: reservationUrl || null,
            limit: 16,
        });
        let imageUrls = scraped;
        if (businessId && scraped.length > 0) {
            if (forceRefresh) {
                imageUrls = await (0, persist_business_public_links_1.replaceBusinessGalleryUrls)(businessId, scraped);
            }
            else {
                imageUrls = await (0, persist_business_public_links_1.persistBusinessGalleryUrls)(businessId, scraped);
            }
        }
        const resolved = await resolveGalleryForClient(imageUrls);
        res.json({
            imageUrls: resolved,
            reservationUrl: reservationUrl || null,
            coverUrl: resolved[0] ?? null,
        });
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to scrape venue images";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=business-venue-images.js.map