"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.campaignImagesRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const pool_1 = require("../db/pool");
const s3_1 = require("../lib/s3");
const suggest_social_images_1 = require("../lib/suggest-social-images");
exports.campaignImagesRouter = (0, express_1.Router)();
const MAX_GALLERY = 6;
const ALLOWED_SOURCES = new Set([
    "manual",
    "website",
    "facebook",
    "instagram",
    "library",
    "social_suggest",
]);
async function mapImageRows(rows) {
    return Promise.all(rows.map(async (row) => ({
        id: row.id,
        imageUrl: await (0, s3_1.resolveStoredImageUrl)(row.image_url),
        storedUrl: row.image_url,
        source: row.source,
        sourceUrl: row.source_url,
        sortOrder: row.sort_order,
        isCover: Boolean(row.is_cover),
    })));
}
async function userCanEditCampaign(userId, isPlatformAdmin, campaign) {
    if (isPlatformAdmin)
        return true;
    if (campaign.created_by_user_id && Number(campaign.created_by_user_id) === userId) {
        return true;
    }
    const { rows } = await pool_1.pool.query(`SELECT 1 FROM organization_users
     WHERE organization_type = 'nonprofit'
       AND organization_id = $1
       AND user_id = $2
     LIMIT 1`, [campaign.nonprofit_id, userId]);
    return rows.length > 0;
}
exports.campaignImagesRouter.post("/suggest", async (req, res) => {
    try {
        const { facebookUrl, instagramHandle, websiteUrl, linkedinUrl, youtubeUrl, limit } = req.body;
        const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : MAX_GALLERY;
        const images = await (0, suggest_social_images_1.suggestSocialImages)({
            facebookUrl: typeof facebookUrl === "string" ? facebookUrl : "",
            instagramHandle: typeof instagramHandle === "string" ? instagramHandle : "",
            websiteUrl: typeof websiteUrl === "string" ? websiteUrl : "",
            linkedinUrl: typeof linkedinUrl === "string" ? linkedinUrl : "",
            youtubeUrl: typeof youtubeUrl === "string" ? youtubeUrl : "",
            limit: Math.min(10, Math.max(1, requested)),
        });
        res.json({ images });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to suggest images" });
    }
});
exports.campaignImagesRouter.get("/:slug", async (req, res) => {
    try {
        const { rows: campaigns } = await pool_1.pool.query(`SELECT id, campaign_status FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(campaigns[0].id);
        const { rows } = await pool_1.pool.query(`SELECT id, image_url, source, source_url, sort_order, is_cover
       FROM campaign_images
       WHERE campaign_id = $1
       ORDER BY sort_order ASC, id ASC
       LIMIT $2`, [campaignId, MAX_GALLERY]);
        res.json({ images: await mapImageRows(rows) });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch campaign images" });
    }
});
exports.campaignImagesRouter.put("/:slug", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const { rows: campaigns } = await connection.query(`SELECT id, nonprofit_id, created_by_user_id, campaign_status
       FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaign = campaigns[0];
        const allowed = await userCanEditCampaign(authUser.id, authUser.isPlatformAdmin, {
            nonprofit_id: Number(campaign.nonprofit_id),
            created_by_user_id: campaign.created_by_user_id
                ? Number(campaign.created_by_user_id)
                : null,
        });
        if (!allowed) {
            res.status(403).json({ error: "Not allowed to edit this campaign" });
            return;
        }
        const body = req.body;
        if (!Array.isArray(body.images)) {
            res.status(400).json({ error: "images array is required" });
            return;
        }
        if (body.images.length > MAX_GALLERY) {
            res.status(400).json({ error: `At most ${MAX_GALLERY} images are allowed` });
            return;
        }
        const normalized = [];
        for (const item of body.images) {
            if (!item || typeof item !== "object")
                continue;
            const row = item;
            const imageUrl = typeof row.imageUrl === "string"
                ? row.imageUrl.trim()
                : typeof row.url === "string"
                    ? row.url.trim()
                    : "";
            if (!imageUrl || imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")) {
                res.status(400).json({
                    error: "Each image needs a durable imageUrl (not a blob: or data: URL)",
                });
                return;
            }
            if (imageUrl.length > 512) {
                res.status(400).json({ error: "imageUrl is too long" });
                return;
            }
            let source = typeof row.source === "string" && ALLOWED_SOURCES.has(row.source)
                ? row.source
                : "manual";
            if (source === "manual" &&
                /^https?:\/\//i.test(imageUrl) &&
                !imageUrl.includes("/uploads/")) {
                source = "social_suggest";
            }
            const sourceUrl = typeof row.sourceUrl === "string" && row.sourceUrl.trim()
                ? row.sourceUrl.trim().slice(0, 512)
                : null;
            normalized.push({
                imageUrl,
                source,
                sourceUrl,
                isCover: Boolean(row.isCover),
            });
        }
        let coverIdx = normalized.findIndex((i) => i.isCover);
        if (coverIdx < 0 && normalized.length > 0)
            coverIdx = 0;
        normalized.forEach((i, idx) => {
            i.isCover = idx === coverIdx;
        });
        const campaignId = Number(campaign.id);
        await connection.query("BEGIN");
        await connection.query(`DELETE FROM campaign_images WHERE campaign_id = $1`, [
            campaignId,
        ]);
        for (let i = 0; i < normalized.length; i++) {
            const img = normalized[i];
            await connection.query(`INSERT INTO campaign_images (
           campaign_id, image_url, source, source_url, sort_order, is_cover
         ) VALUES ($1, $2, $3, $4, $5, $6)`, [campaignId, img.imageUrl, img.source, img.sourceUrl, i, img.isCover]);
        }
        const cover = normalized.find((i) => i.isCover);
        if (cover) {
            await connection.query(`UPDATE campaigns SET cover_image_url = $1, updated_at = NOW() WHERE id = $2`, [cover.imageUrl, campaignId]);
        }
        await connection.query("COMMIT");
        const { rows } = await connection.query(`SELECT id, image_url, source, source_url, sort_order, is_cover
       FROM campaign_images
       WHERE campaign_id = $1
       ORDER BY sort_order ASC, id ASC`, [campaignId]);
        res.json({ images: await mapImageRows(rows) });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to save campaign images" });
    }
    finally {
        connection.release();
    }
});
//# sourceMappingURL=campaign-images.js.map