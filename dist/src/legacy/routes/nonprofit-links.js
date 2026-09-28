"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nonprofitLinksRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const persist_nonprofit_public_links_1 = require("../lib/persist-nonprofit-public-links");
const pool_1 = require("../db/pool");
exports.nonprofitLinksRouter = (0, express_1.Router)();
function optionalString(raw) {
    if (raw === undefined)
        return undefined;
    if (raw === null)
        return null;
    if (typeof raw !== "string")
        return undefined;
    return raw;
}
exports.nonprofitLinksRouter.post("/nonprofit-links", async (req, res) => {
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
        if (Object.prototype.hasOwnProperty.call(body, "youtubeUrl")) {
            patch.youtubeUrl = optionalString(body.youtubeUrl) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "phone")) {
            patch.phone = optionalString(body.phone) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "contactEmail")) {
            patch.contactEmail = optionalString(body.contactEmail) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "about")) {
            patch.about = optionalString(body.about) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "city")) {
            patch.city = optionalString(body.city) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "state")) {
            patch.state = optionalString(body.state) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "zip")) {
            patch.zip = optionalString(body.zip) ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "organizationName")) {
            patch.organizationName = optionalString(body.organizationName) ?? null;
        }
        if (Object.keys(patch).length === 0) {
            const { rows } = await pool_1.pool.query(`SELECT website, facebook_url, instagram_url, linkedin_url, tiktok_url,
                youtube_url, contact_phone, contact_email, description, mission,
                city, state, zip, organization_name
         FROM nonprofits WHERE id = $1 LIMIT 1`, [nonprofitId]);
            const row = rows[0];
            const about = row?.description?.trim() || row?.mission?.trim() || null;
            res.json({
                website: row?.website?.trim() || null,
                facebookUrl: row?.facebook_url?.trim() || null,
                instagramUrl: row?.instagram_url?.trim() || null,
                linkedinUrl: row?.linkedin_url?.trim() || null,
                tiktokUrl: row?.tiktok_url?.trim() || null,
                youtubeUrl: row?.youtube_url?.trim() || null,
                phone: row?.contact_phone?.trim() || null,
                contactEmail: row?.contact_email?.trim() || null,
                about,
                city: row?.city?.trim() || null,
                state: row?.state?.trim() || null,
                zip: row?.zip?.trim() || null,
                organizationName: row?.organization_name?.trim() || null,
            });
            return;
        }
        const written = await (0, persist_nonprofit_public_links_1.updateNonprofitPublicLinks)(nonprofitId, patch);
        if (written == null) {
            res.status(500).json({ error: "Failed to save organization links." });
            return;
        }
        res.json(written);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to save organization links";
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=nonprofit-links.js.map