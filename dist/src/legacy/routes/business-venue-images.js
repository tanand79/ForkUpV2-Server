"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.businessVenueImagesRouter = void 0;
const express_1 = require("express");
const business_venue_images_1 = require("../lib/business-venue-images");
const business_website_location_1 = require("../lib/business-website-location");
exports.businessVenueImagesRouter = (0, express_1.Router)();
exports.businessVenueImagesRouter.post("/business-venue-images", async (req, res) => {
    try {
        const websiteUrl = typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
        if (!websiteUrl) {
            res.status(400).json({ error: "websiteUrl is required." });
            return;
        }
        let reservationUrl = typeof req.body?.reservationUrl === "string"
            ? req.body.reservationUrl.trim()
            : "";
        if (!reservationUrl) {
            try {
                const hints = await (0, business_website_location_1.scrapeBusinessLocationHints)(websiteUrl);
                reservationUrl = hints.reservationUrl?.trim() || "";
            }
            catch {
            }
        }
        const imageUrls = await (0, business_venue_images_1.scrapeBusinessVenueImages)({
            websiteUrl,
            reservationUrl: reservationUrl || null,
            limit: 16,
        });
        res.json({
            imageUrls,
            reservationUrl: reservationUrl || null,
        });
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to scrape venue images";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=business-venue-images.js.map