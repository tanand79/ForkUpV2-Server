"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.persistBusinessPublicLinks = persistBusinessPublicLinks;
exports.updateBusinessPublicLinks = updateBusinessPublicLinks;
exports.persistBusinessGalleryUrls = persistBusinessGalleryUrls;
exports.mergeBusinessGalleryUrls = mergeBusinessGalleryUrls;
exports.persistBusinessVenueCoverUrl = persistBusinessVenueCoverUrl;
const pool_1 = require("../db/pool");
function trimOrNull(value) {
    if (typeof value !== "string")
        return null;
    const t = value.trim();
    return t || null;
}
async function persistBusinessPublicLinks(businessId, links) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return;
    const website = trimOrNull(links.website);
    const facebookUrl = trimOrNull(links.facebookUrl);
    const instagramUrl = trimOrNull(links.instagramUrl);
    const linkedinUrl = trimOrNull(links.linkedinUrl);
    const tiktokUrl = trimOrNull(links.tiktokUrl);
    const phone = trimOrNull(links.phone);
    const venueEmail = trimOrNull(links.venueEmail);
    if (!website &&
        !facebookUrl &&
        !instagramUrl &&
        !linkedinUrl &&
        !tiktokUrl &&
        !phone &&
        !venueEmail) {
        return;
    }
    try {
        await pool_1.pool.query(`UPDATE businesses SET
         website = COALESCE(NULLIF(TRIM(website), ''), $2),
         facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
         instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
         linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
         tiktok_url = COALESCE(NULLIF(TRIM(tiktok_url), ''), $6),
         contact_phone = COALESCE(NULLIF(TRIM(contact_phone), ''), $7),
         venue_email = COALESCE(NULLIF(TRIM(venue_email), ''), $8),
         updated_at = NOW()
       WHERE id = $1`, [
            businessId,
            website,
            facebookUrl,
            instagramUrl,
            linkedinUrl,
            tiktokUrl,
            phone,
            venueEmail,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/venue_email/i.test(message)) {
            console.error("persistBusinessPublicLinks failed:", err);
            return;
        }
        try {
            await pool_1.pool.query(`UPDATE businesses SET
           website = COALESCE(NULLIF(TRIM(website), ''), $2),
           facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
           instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
           linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
           tiktok_url = COALESCE(NULLIF(TRIM(tiktok_url), ''), $6),
           contact_phone = COALESCE(NULLIF(TRIM(contact_phone), ''), $7),
           updated_at = NOW()
         WHERE id = $1`, [
                businessId,
                website,
                facebookUrl,
                instagramUrl,
                linkedinUrl,
                tiktokUrl,
                phone,
            ]);
        }
        catch (err2) {
            console.error("persistBusinessPublicLinks fallback failed:", err2);
        }
    }
}
async function updateBusinessPublicLinks(businessId, links) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return null;
    const sets = [];
    const params = [businessId];
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
    push("contact_phone", "phone", links.phone, Object.prototype.hasOwnProperty.call(links, "phone"));
    push("venue_email", "venueEmail", links.venueEmail, Object.prototype.hasOwnProperty.call(links, "venueEmail"));
    if (sets.length === 0)
        return {};
    try {
        await pool_1.pool.query(`UPDATE businesses SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, params);
        return written;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/venue_email/i.test(message) &&
            Object.prototype.hasOwnProperty.call(links, "venueEmail")) {
            const { venueEmail: _drop, ...rest } = links;
            return updateBusinessPublicLinks(businessId, rest);
        }
        console.error("updateBusinessPublicLinks failed:", err);
        return null;
    }
}
async function persistBusinessGalleryUrls(businessId, urls) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return;
    const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
    if (clean.length === 0)
        return;
    try {
        await pool_1.pool.query(`UPDATE businesses SET
         venue_gallery_urls = CASE
           WHEN venue_gallery_urls IS NULL
             OR jsonb_typeof(venue_gallery_urls) <> 'array'
             OR jsonb_array_length(venue_gallery_urls) = 0
           THEN $2::jsonb
           WHEN jsonb_array_length(venue_gallery_urls) < $3
           THEN $2::jsonb
           ELSE venue_gallery_urls
         END,
         updated_at = NOW()
       WHERE id = $1`, [businessId, JSON.stringify(clean), clean.length]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/venue_gallery_urls/i.test(message)) {
            console.error("persistBusinessGalleryUrls failed:", err);
        }
    }
}
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
async function mergeBusinessGalleryUrls(businessId, urls) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return [];
    const incoming = urls.map((u) => u.trim()).filter(Boolean);
    if (incoming.length === 0) {
        try {
            const { rows } = await pool_1.pool.query(`SELECT venue_gallery_urls FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
            return parseGalleryUrls(rows[0]?.venue_gallery_urls);
        }
        catch {
            return [];
        }
    }
    try {
        const { rows } = await pool_1.pool.query(`SELECT venue_gallery_urls FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
        const existing = parseGalleryUrls(rows[0]?.venue_gallery_urls);
        const merged = [...new Set([...existing, ...incoming])].slice(0, 24);
        await pool_1.pool.query(`UPDATE businesses SET
         venue_gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`, [businessId, JSON.stringify(merged)]);
        return merged;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/venue_gallery_urls/i.test(message)) {
            console.error("mergeBusinessGalleryUrls failed:", err);
        }
        return [];
    }
}
async function persistBusinessVenueCoverUrl(businessId, coverUrl) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return null;
    const clean = typeof coverUrl === "string" && coverUrl.trim() ? coverUrl.trim() : null;
    try {
        await pool_1.pool.query(`UPDATE businesses SET
         venue_cover_url = $2,
         updated_at = NOW()
       WHERE id = $1`, [businessId, clean]);
        return clean;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/venue_cover_url/i.test(message)) {
            console.error("persistBusinessVenueCoverUrl failed:", err);
        }
        return null;
    }
}
//# sourceMappingURL=persist-business-public-links.js.map