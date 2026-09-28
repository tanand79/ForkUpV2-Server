"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadAndHydrateNonprofitOrgProfile = loadAndHydrateNonprofitOrgProfile;
const pool_1 = require("../db/pool");
const organization_ai_campaign_flow_1 = require("./organization-ai-campaign-flow");
const persist_nonprofit_public_links_1 = require("./persist-nonprofit-public-links");
function trimOrNull(value) {
    if (typeof value !== "string")
        return null;
    const t = value.trim();
    return t || null;
}
function rowToPayload(row) {
    const galleryImageUrls = (0, persist_nonprofit_public_links_1.parseNonprofitGalleryUrls)(row.gallery_urls);
    return {
        nonprofitId: row.id,
        organizationName: row.organization_name,
        slug: row.slug,
        about: row.description?.trim() || row.mission?.trim() || "",
        mission: row.mission,
        website: trimOrNull(row.website),
        contactName: row.contact_name,
        contactEmail: trimOrNull(row.contact_email),
        phone: trimOrNull(row.contact_phone),
        causeCategory: row.cause_category,
        city: trimOrNull(row.city),
        state: trimOrNull(row.state),
        zip: trimOrNull(row.zip),
        logoUrl: trimOrNull(row.logo_url),
        facebookUrl: trimOrNull(row.facebook_url),
        instagramUrl: trimOrNull(row.instagram_url),
        linkedinUrl: trimOrNull(row.linkedin_url),
        tiktokUrl: trimOrNull(row.tiktok_url),
        youtubeUrl: trimOrNull(row.youtube_url),
        galleryImageUrls,
        coverUrl: trimOrNull(row.cover_url),
    };
}
function needsHydrate(payload) {
    const hasSocial = Boolean(payload.facebookUrl ||
        payload.instagramUrl ||
        payload.linkedinUrl ||
        payload.youtubeUrl ||
        payload.tiktokUrl ||
        payload.website);
    const hasLocation = Boolean(payload.city || payload.state);
    return !hasSocial || !hasLocation;
}
async function loadLatestAiAnalysis(nonprofitId, organizationName) {
    try {
        const { rows } = await pool_1.pool.query(`SELECT website, facebook_url, instagram_url, linkedin_url, analysis_json
         FROM organization_ai_analysis_sessions
        WHERE status = 'completed'
          AND analysis_json IS NOT NULL
          AND (
            nonprofit_id = $1
            OR (
              nonprofit_id IS NULL
              AND LOWER(TRIM(organization_name)) = LOWER(TRIM($2))
            )
          )
        ORDER BY
          CASE WHEN nonprofit_id = $1 THEN 0 ELSE 1 END,
          id DESC
        LIMIT 1`, [nonprofitId, organizationName]);
        const row = rows[0];
        if (!row)
            return null;
        const analysis = row.analysis_json && typeof row.analysis_json === "object"
            ? row.analysis_json
            : null;
        return {
            website: analysis?.website || row.website,
            facebookUrl: analysis?.facebookUrl || row.facebook_url,
            instagramUrl: analysis?.instagramUrl || row.instagram_url,
            linkedinUrl: analysis?.linkedinUrl || row.linkedin_url,
            youtubeUrl: analysis?.youtubeUrl || null,
            city: analysis?.city || null,
            state: analysis?.state || null,
            mission: analysis?.mission || null,
            images: Array.isArray(analysis?.images) ? analysis.images : [],
        };
    }
    catch {
        return null;
    }
}
async function reloadNonprofit(nonprofitId) {
    const { rows } = await pool_1.pool.query(`SELECT id, organization_name, slug, mission, description, website,
            contact_name, contact_email, contact_phone, cause_category, ein,
            city, state, zip, logo_url,
            facebook_url, instagram_url, linkedin_url, tiktok_url, youtube_url,
            gallery_urls, cover_url
       FROM nonprofits WHERE id = $1 LIMIT 1`, [nonprofitId]);
    return rows[0] ?? null;
}
async function loadAndHydrateNonprofitOrgProfile(nonprofitId) {
    const initial = await reloadNonprofit(nonprofitId);
    if (!initial)
        return null;
    let payload = rowToPayload(initial);
    if (!needsHydrate(payload))
        return payload;
    const ai = await loadLatestAiAnalysis(nonprofitId, payload.organizationName);
    if (ai) {
        await (0, persist_nonprofit_public_links_1.fillNonprofitPublicProfileNullOnly)(nonprofitId, {
            website: ai.website,
            facebookUrl: ai.facebookUrl,
            instagramUrl: ai.instagramUrl,
            linkedinUrl: ai.linkedinUrl,
            youtubeUrl: ai.youtubeUrl,
            city: ai.city,
            state: ai.state,
            about: ai.mission,
            mission: ai.mission,
        });
        const afterAi = await reloadNonprofit(nonprofitId);
        if (afterAi)
            payload = rowToPayload(afterAi);
        if (!needsHydrate(payload))
            return payload;
    }
    try {
        const sources = await (0, organization_ai_campaign_flow_1.resolveAnalysisSources)({
            organizationName: payload.organizationName,
            nonprofitId,
            website: payload.website,
            facebookUrl: payload.facebookUrl,
            instagramUrl: payload.instagramUrl,
            linkedinUrl: payload.linkedinUrl,
            youtubeUrl: payload.youtubeUrl,
            mission: payload.mission,
            causeCategory: payload.causeCategory,
            city: payload.city,
            state: payload.state,
            ein: initial.ein,
        });
        const pageMeta = sources.website
            ? await (0, organization_ai_campaign_flow_1.extractOrgPageMeta)(sources.website)
            : null;
        const about = sources.mission || pageMeta?.description || payload.about || null;
        await (0, persist_nonprofit_public_links_1.fillNonprofitPublicProfileNullOnly)(nonprofitId, {
            website: sources.website,
            facebookUrl: sources.facebookUrl,
            instagramUrl: sources.instagramUrl,
            linkedinUrl: sources.linkedinUrl,
            youtubeUrl: sources.youtubeUrl,
            city: sources.city,
            state: sources.state,
            about,
            mission: sources.mission || about,
        });
    }
    catch (err) {
        console.error("nonprofit org profile live hydrate failed:", err);
    }
    const finalRow = await reloadNonprofit(nonprofitId);
    return finalRow ? rowToPayload(finalRow) : payload;
}
//# sourceMappingURL=hydrate-nonprofit-org-profile.js.map