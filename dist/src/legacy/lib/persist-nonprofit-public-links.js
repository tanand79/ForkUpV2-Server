"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fillNonprofitPublicProfileNullOnly = fillNonprofitPublicProfileNullOnly;
exports.parseNonprofitGalleryUrls = parseNonprofitGalleryUrls;
exports.updateNonprofitPublicLinks = updateNonprofitPublicLinks;
exports.mergeNonprofitGalleryUrls = mergeNonprofitGalleryUrls;
exports.replaceNonprofitGalleryUrls = replaceNonprofitGalleryUrls;
exports.persistNonprofitCoverUrl = persistNonprofitCoverUrl;
const pool_1 = require("../db/pool");
function trimOrNull(value) {
    if (typeof value !== "string")
        return null;
    const t = value.trim();
    return t || null;
}
async function fillNonprofitPublicProfileNullOnly(nonprofitId, fill) {
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0)
        return;
    const website = trimOrNull(fill.website);
    const facebookUrl = trimOrNull(fill.facebookUrl);
    const instagramUrl = trimOrNull(fill.instagramUrl);
    const linkedinUrl = trimOrNull(fill.linkedinUrl);
    const youtubeUrl = trimOrNull(fill.youtubeUrl);
    const city = trimOrNull(fill.city);
    const state = trimOrNull(fill.state);
    const about = trimOrNull(fill.about);
    const mission = trimOrNull(fill.mission);
    const logoUrl = trimOrNull(fill.logoUrl);
    if (!website &&
        !facebookUrl &&
        !instagramUrl &&
        !linkedinUrl &&
        !youtubeUrl &&
        !city &&
        !state &&
        !about &&
        !mission &&
        !logoUrl) {
        return;
    }
    try {
        await pool_1.pool.query(`UPDATE nonprofits SET
         website = COALESCE(NULLIF(TRIM(website), ''), $2),
         facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
         instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
         linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
         youtube_url = COALESCE(NULLIF(TRIM(youtube_url), ''), $6),
         city = COALESCE(NULLIF(TRIM(city), ''), $7),
         state = COALESCE(NULLIF(TRIM(state), ''), $8),
         description = COALESCE(NULLIF(TRIM(description), ''), $9),
         mission = COALESCE(NULLIF(TRIM(mission), ''), $10),
         logo_url = COALESCE(NULLIF(TRIM(logo_url), ''), $11),
         updated_at = NOW()
       WHERE id = $1`, [
            nonprofitId,
            website,
            facebookUrl,
            instagramUrl,
            linkedinUrl,
            youtubeUrl,
            city,
            state,
            about,
            mission,
            logoUrl,
        ]);
    }
    catch (err) {
        console.error("fillNonprofitPublicProfileNullOnly failed:", err);
    }
}
function parseNonprofitGalleryUrls(raw) {
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
async function updateNonprofitPublicLinks(nonprofitId, links) {
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0)
        return null;
    const sets = [];
    const params = [nonprofitId];
    const written = {};
    const push = (column, key, value, present) => {
        if (!present)
            return;
        const clean = trimOrNull(value);
        params.push(clean);
        sets.push(`${column} = $${params.length}`);
        written[key] = clean;
    };
    push("website", "website", links.website, Object.prototype.hasOwnProperty.call(links, "website"));
    push("facebook_url", "facebookUrl", links.facebookUrl, Object.prototype.hasOwnProperty.call(links, "facebookUrl"));
    push("instagram_url", "instagramUrl", links.instagramUrl, Object.prototype.hasOwnProperty.call(links, "instagramUrl"));
    push("linkedin_url", "linkedinUrl", links.linkedinUrl, Object.prototype.hasOwnProperty.call(links, "linkedinUrl"));
    push("tiktok_url", "tiktokUrl", links.tiktokUrl, Object.prototype.hasOwnProperty.call(links, "tiktokUrl"));
    push("youtube_url", "youtubeUrl", links.youtubeUrl, Object.prototype.hasOwnProperty.call(links, "youtubeUrl"));
    push("contact_phone", "phone", links.phone, Object.prototype.hasOwnProperty.call(links, "phone"));
    push("contact_email", "contactEmail", links.contactEmail, Object.prototype.hasOwnProperty.call(links, "contactEmail"));
    push("description", "about", links.about, Object.prototype.hasOwnProperty.call(links, "about"));
    push("city", "city", links.city, Object.prototype.hasOwnProperty.call(links, "city"));
    push("state", "state", links.state, Object.prototype.hasOwnProperty.call(links, "state"));
    push("zip", "zip", links.zip, Object.prototype.hasOwnProperty.call(links, "zip"));
    push("organization_name", "organizationName", links.organizationName, Object.prototype.hasOwnProperty.call(links, "organizationName"));
    if (sets.length === 0)
        return {};
    try {
        await pool_1.pool.query(`UPDATE nonprofits SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, params);
        return written;
    }
    catch (err) {
        console.error("updateNonprofitPublicLinks failed:", err);
        return null;
    }
}
async function mergeNonprofitGalleryUrls(nonprofitId, urls) {
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0)
        return [];
    const incoming = urls.map((u) => u.trim()).filter(Boolean);
    if (incoming.length === 0) {
        try {
            const { rows } = await pool_1.pool.query(`SELECT gallery_urls FROM nonprofits WHERE id = $1 LIMIT 1`, [nonprofitId]);
            return parseNonprofitGalleryUrls(rows[0]?.gallery_urls);
        }
        catch {
            return [];
        }
    }
    try {
        const { rows } = await pool_1.pool.query(`SELECT gallery_urls FROM nonprofits WHERE id = $1 LIMIT 1`, [nonprofitId]);
        const existing = parseNonprofitGalleryUrls(rows[0]?.gallery_urls);
        const merged = [...new Set([...existing, ...incoming])].slice(0, 24);
        await pool_1.pool.query(`UPDATE nonprofits SET
         gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`, [nonprofitId, JSON.stringify(merged)]);
        return merged;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/gallery_urls/i.test(message)) {
            console.error("mergeNonprofitGalleryUrls failed:", err);
        }
        return [];
    }
}
async function replaceNonprofitGalleryUrls(nonprofitId, urls) {
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0)
        return [];
    const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
    try {
        await pool_1.pool.query(`UPDATE nonprofits SET
         gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`, [nonprofitId, JSON.stringify(clean)]);
        return clean;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/gallery_urls/i.test(message)) {
            console.error("replaceNonprofitGalleryUrls failed:", err);
        }
        return [];
    }
}
async function persistNonprofitCoverUrl(nonprofitId, coverUrl) {
    if (!Number.isFinite(nonprofitId) || nonprofitId <= 0)
        return null;
    const clean = typeof coverUrl === "string" && coverUrl.trim() ? coverUrl.trim() : null;
    try {
        await pool_1.pool.query(`UPDATE nonprofits SET
         cover_url = $2,
         updated_at = NOW()
       WHERE id = $1`, [nonprofitId, clean]);
        return clean;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/cover_url/i.test(message)) {
            console.error("persistNonprofitCoverUrl failed:", err);
        }
        return null;
    }
}
//# sourceMappingURL=persist-nonprofit-public-links.js.map