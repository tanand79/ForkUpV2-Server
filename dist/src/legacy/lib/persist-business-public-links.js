"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VENUE_DISCOUNT_DAYS = void 0;
exports.defaultVenueDiscountHours = defaultVenueDiscountHours;
exports.normalizeVenueDiscountHours = normalizeVenueDiscountHours;
exports.venueDiscountHoursHaveOpenDay = venueDiscountHoursHaveOpenDay;
exports.persistVenueDiscountHours = persistVenueDiscountHours;
exports.persistPrimaryBusinessLocationDetails = persistPrimaryBusinessLocationDetails;
exports.updatePrimaryBusinessLocationDetails = updatePrimaryBusinessLocationDetails;
exports.persistBusinessPublicLinks = persistBusinessPublicLinks;
exports.updateBusinessPublicLinks = updateBusinessPublicLinks;
exports.persistBusinessGalleryUrls = persistBusinessGalleryUrls;
exports.replaceBusinessGalleryUrls = replaceBusinessGalleryUrls;
exports.mergeBusinessGalleryUrls = mergeBusinessGalleryUrls;
exports.persistBusinessVenueCoverUrl = persistBusinessVenueCoverUrl;
const pool_1 = require("../db/pool");
const ensure_durable_image_1 = require("./ensure-durable-image");
function trimOrNull(value) {
    if (typeof value !== "string")
        return null;
    const t = value.trim();
    return t || null;
}
exports.VENUE_DISCOUNT_DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
function defaultVenueDiscountHours() {
    return {
        Monday: "-",
        Tuesday: "-",
        Wednesday: "-",
        Thursday: "-",
        Friday: "-",
        Saturday: "-",
        Sunday: "-",
    };
}
function normalizeVenueDiscountHours(value) {
    const hours = defaultVenueDiscountHours();
    if (!value || typeof value !== "object")
        return hours;
    for (const day of exports.VENUE_DISCOUNT_DAYS) {
        const raw = value[day];
        if (typeof raw !== "string")
            continue;
        const trimmed = raw.trim();
        hours[day] = trimmed || "-";
    }
    return hours;
}
function venueDiscountHoursHaveOpenDay(hours) {
    return exports.VENUE_DISCOUNT_DAYS.some((day) => {
        const v = hours[day]?.trim() ?? "";
        return Boolean(v) && v !== "-" && v !== "—";
    });
}
async function persistVenueDiscountHours(businessId, hours, eligibleWindow, options) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return;
    const overwrite = options?.overwrite === true;
    const markResolved = options?.markResolved !== false;
    const normalized = normalizeVenueDiscountHours(hours ?? null);
    const hasOpen = venueDiscountHoursHaveOpenDay(normalized);
    if (!hasOpen && !markResolved && !overwrite)
        return;
    const payload = JSON.stringify(normalized);
    const windowVal = trimOrNull(eligibleWindow);
    try {
        if (overwrite) {
            await pool_1.pool.query(`UPDATE businesses SET
           venue_discount_hours = $2::jsonb,
           venue_eligible_window = COALESCE($3, venue_eligible_window),
           updated_at = NOW()
         WHERE id = $1`, [businessId, payload, windowVal]);
            return;
        }
        await pool_1.pool.query(`UPDATE businesses SET
         venue_discount_hours = COALESCE(venue_discount_hours, $2::jsonb),
         venue_eligible_window = COALESCE(NULLIF(TRIM(venue_eligible_window), ''), $3),
         updated_at = NOW()
       WHERE id = $1`, [businessId, payload, windowVal]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/venue_discount_hours|venue_eligible_window/i.test(message)) {
            console.error("persistVenueDiscountHours failed:", err);
        }
    }
}
async function persistPrimaryBusinessLocationDetails(businessId, loc) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return;
    const address = trimOrNull(loc.address);
    const city = trimOrNull(loc.city);
    const state = trimOrNull(loc.state);
    const zip = trimOrNull(loc.zip);
    const phone = trimOrNull(loc.phone);
    if (!address && !city && !state && !zip && !phone)
        return;
    try {
        await pool_1.pool.query(`UPDATE business_locations SET
         address = COALESCE(NULLIF(TRIM(address), ''), $2),
         city = COALESCE(NULLIF(TRIM(city), ''), $3),
         state = COALESCE(NULLIF(TRIM(state), ''), $4),
         zip = COALESCE(NULLIF(TRIM(zip), ''), $5),
         phone = COALESCE(NULLIF(TRIM(phone), ''), $6),
         updated_at = NOW()
       WHERE id = (
         SELECT id FROM business_locations
         WHERE business_id = $1 AND active_status = TRUE
         ORDER BY id ASC
         LIMIT 1
       )`, [businessId, address, city, state, zip, phone]);
    }
    catch (err) {
        console.error("persistPrimaryBusinessLocationDetails failed:", err);
    }
}
async function updatePrimaryBusinessLocationDetails(businessId, loc) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return;
    const sets = [];
    const params = [businessId];
    const push = (column, value, present) => {
        if (!present)
            return;
        params.push(trimOrNull(value));
        sets.push(`${column} = $${params.length}`);
    };
    push("address", loc.address, Object.prototype.hasOwnProperty.call(loc, "address"));
    push("city", loc.city, Object.prototype.hasOwnProperty.call(loc, "city"));
    push("state", loc.state, Object.prototype.hasOwnProperty.call(loc, "state"));
    push("zip", loc.zip, Object.prototype.hasOwnProperty.call(loc, "zip"));
    push("phone", loc.phone, Object.prototype.hasOwnProperty.call(loc, "phone"));
    if (sets.length === 0)
        return;
    try {
        await pool_1.pool.query(`UPDATE business_locations SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = (
         SELECT id FROM business_locations
         WHERE business_id = $1 AND active_status = TRUE
         ORDER BY id ASC
         LIMIT 1
       )`, params);
    }
    catch (err) {
        console.error("updatePrimaryBusinessLocationDetails failed:", err);
    }
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
    const description = trimOrNull(links.description);
    const hasHoursInput = links.discountHours != null ||
        Object.prototype.hasOwnProperty.call(links, "eligibleWindow");
    if (!website &&
        !facebookUrl &&
        !instagramUrl &&
        !linkedinUrl &&
        !tiktokUrl &&
        !phone &&
        !venueEmail &&
        !description &&
        !hasHoursInput) {
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
         description = COALESCE(NULLIF(TRIM(description), ''), $9),
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
            description,
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
           description = COALESCE(NULLIF(TRIM(description), ''), $8),
           updated_at = NOW()
         WHERE id = $1`, [
                businessId,
                website,
                facebookUrl,
                instagramUrl,
                linkedinUrl,
                tiktokUrl,
                phone,
                description,
            ]);
        }
        catch (err2) {
            console.error("persistBusinessPublicLinks fallback failed:", err2);
        }
    }
    if (hasHoursInput) {
        await persistVenueDiscountHours(businessId, links.discountHours ?? null, links.eligibleWindow, { markResolved: true });
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
    push("business_name", "businessName", links.businessName, Object.prototype.hasOwnProperty.call(links, "businessName") &&
        Boolean(trimOrNull(links.businessName)));
    push("website", "website", links.website, Object.prototype.hasOwnProperty.call(links, "website"));
    push("facebook_url", "facebookUrl", links.facebookUrl, Object.prototype.hasOwnProperty.call(links, "facebookUrl"));
    push("instagram_url", "instagramUrl", links.instagramUrl, Object.prototype.hasOwnProperty.call(links, "instagramUrl"));
    push("linkedin_url", "linkedinUrl", links.linkedinUrl, Object.prototype.hasOwnProperty.call(links, "linkedinUrl"));
    push("tiktok_url", "tiktokUrl", links.tiktokUrl, Object.prototype.hasOwnProperty.call(links, "tiktokUrl"));
    push("contact_phone", "phone", links.phone, Object.prototype.hasOwnProperty.call(links, "phone"));
    push("venue_email", "venueEmail", links.venueEmail, Object.prototype.hasOwnProperty.call(links, "venueEmail"));
    push("description", "description", links.description, Object.prototype.hasOwnProperty.call(links, "description"));
    const hasHours = Object.prototype.hasOwnProperty.call(links, "discountHours");
    const hasWindow = Object.prototype.hasOwnProperty.call(links, "eligibleWindow");
    if (hasHours) {
        const normalized = normalizeVenueDiscountHours(links.discountHours ?? null);
        params.push(JSON.stringify(normalized));
        sets.push(`venue_discount_hours = $${params.length}::jsonb`);
        written.discountHours = normalized;
    }
    if (hasWindow) {
        const windowVal = trimOrNull(links.eligibleWindow);
        params.push(windowVal);
        sets.push(`venue_eligible_window = $${params.length}`);
        written.eligibleWindow = windowVal;
    }
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
        if (/venue_discount_hours|venue_eligible_window/i.test(message) &&
            (hasHours || hasWindow)) {
            const { discountHours: _h, eligibleWindow: _w, ...rest } = links;
            return updateBusinessPublicLinks(businessId, rest);
        }
        console.error("updateBusinessPublicLinks failed:", err);
        return null;
    }
}
async function persistBusinessGalleryUrls(businessId, urls) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return [];
    const durable = await (0, ensure_durable_image_1.ensureDurableVenueGalleryUrls)(urls);
    const clean = [...new Set(durable.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
    if (clean.length === 0)
        return [];
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
    return clean;
}
async function replaceBusinessGalleryUrls(businessId, urls) {
    if (!Number.isFinite(businessId) || businessId <= 0)
        return [];
    const durable = await (0, ensure_durable_image_1.ensureDurableVenueGalleryUrls)(urls);
    const clean = [...new Set(durable.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
    try {
        await pool_1.pool.query(`UPDATE businesses SET
         venue_gallery_urls = $2::jsonb,
         venue_cover_url = COALESCE($3, venue_cover_url),
         updated_at = NOW()
       WHERE id = $1`, [businessId, JSON.stringify(clean), clean[0] ?? null]);
        return clean;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/venue_cover_url/i.test(message)) {
            try {
                await pool_1.pool.query(`UPDATE businesses SET
             venue_gallery_urls = $2::jsonb,
             updated_at = NOW()
           WHERE id = $1`, [businessId, JSON.stringify(clean)]);
                return clean;
            }
            catch (err2) {
                console.error("replaceBusinessGalleryUrls fallback failed:", err2);
                return clean;
            }
        }
        if (!/venue_gallery_urls/i.test(message)) {
            console.error("replaceBusinessGalleryUrls failed:", err);
        }
        return clean;
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
        const durableIncoming = await (0, ensure_durable_image_1.ensureDurableVenueGalleryUrls)(incoming);
        const merged = [...new Set([...existing, ...durableIncoming])].slice(0, 24);
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