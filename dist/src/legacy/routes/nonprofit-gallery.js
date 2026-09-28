"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nonprofitGalleryRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const persist_nonprofit_public_links_1 = require("../lib/persist-nonprofit-public-links");
const pool_1 = require("../db/pool");
exports.nonprofitGalleryRouter = (0, express_1.Router)();
async function loadOrgMedia(nonprofitId) {
    const { rows } = await pool_1.pool.query(`SELECT gallery_urls, cover_url FROM nonprofits WHERE id = $1 LIMIT 1`, [nonprofitId]);
    return {
        imageUrls: (0, persist_nonprofit_public_links_1.parseNonprofitGalleryUrls)(rows[0]?.gallery_urls),
        coverUrl: rows[0]?.cover_url?.trim() || null,
    };
}
exports.nonprofitGalleryRouter.post("/nonprofit-gallery", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in required." });
            return;
        }
        const nonprofitIdRaw = Number(req.body?.nonprofitId);
        const nonprofitId = Number.isFinite(nonprofitIdRaw) && nonprofitIdRaw > 0
            ? nonprofitIdRaw
            : null;
        if (!nonprofitId) {
            res.status(400).json({ error: "nonprofitId is required." });
            return;
        }
        if (!(0, campaign_partner_join_requests_1.userBelongsToNonprofit)(user, nonprofitId)) {
            res.status(403).json({ error: "Not authorized for this organization." });
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
            const current = await loadOrgMedia(nonprofitId);
            res.json(current);
            return;
        }
        let merged = imageUrls.length > 0
            ? await (0, persist_nonprofit_public_links_1.mergeNonprofitGalleryUrls)(nonprofitId, imageUrls)
            : (await loadOrgMedia(nonprofitId)).imageUrls;
        let coverUrl = null;
        if (hasCoverField) {
            coverUrl = await (0, persist_nonprofit_public_links_1.persistNonprofitCoverUrl)(nonprofitId, coverInput ?? null);
            if (coverUrl && !merged.includes(coverUrl)) {
                merged = await (0, persist_nonprofit_public_links_1.mergeNonprofitGalleryUrls)(nonprofitId, [coverUrl]);
            }
        }
        else {
            coverUrl = (await loadOrgMedia(nonprofitId)).coverUrl;
        }
        res.json({ imageUrls: merged, coverUrl });
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to save organization gallery";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=nonprofit-gallery.js.map