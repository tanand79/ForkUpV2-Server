"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchApprovedLibraryItems = fetchApprovedLibraryItems;
exports.buildLibraryContext = buildLibraryContext;
exports.pickLaunchSnippet = pickLaunchSnippet;
exports.pickImpactSnippet = pickImpactSnippet;
exports.pickPromotionChannels = pickPromotionChannels;
exports.pickFeaturedImage = pickFeaturedImage;
const pool_1 = require("../db/pool");
async function fetchApprovedLibraryItems(orgType, orgId) {
    if (!orgId)
        return [];
    try {
        const { rows } = await pool_1.pool.query(`SELECT category, title, content, source_url, asset_url
       FROM organization_library_items
       WHERE organization_type = $1
         AND organization_id = $2
         AND review_status = 'approved'
       ORDER BY category ASC, id DESC`, [orgType, orgId]);
        return rows.map((r) => ({
            category: String(r.category),
            title: r.title ? String(r.title) : null,
            content: r.content ? String(r.content) : null,
            sourceUrl: r.source_url ? String(r.source_url) : null,
            assetUrl: r.asset_url ? String(r.asset_url) : null,
        }));
    }
    catch (err) {
        console.error("[organization-library] Failed to load approved items:", err);
        return [];
    }
}
const CONTENT_CATEGORIES = new Set([
    "stories_testimonials",
    "results_impact",
    "reusable_content",
    "past_events",
]);
function buildLibraryContext(items) {
    const useful = items.filter((i) => CONTENT_CATEGORIES.has(i.category) && (i.title || i.content));
    if (useful.length === 0)
        return "";
    const lines = useful.slice(0, 12).map((i) => {
        const label = i.title ? `${i.title}: ` : "";
        return `- (${i.category}) ${label}${i.content ?? ""}`.trim();
    });
    return `Approved organization library content (use for authentic voice; do not invent beyond this):\n${lines.join("\n")}`;
}
function pickLaunchSnippet(items) {
    const preferred = items.find((i) => i.category === "reusable_content" && i.content) ??
        items.find((i) => i.category === "stories_testimonials" && i.content) ??
        items.find((i) => i.category === "results_impact" && i.content);
    const text = preferred?.content?.trim();
    if (!text)
        return null;
    return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}
function pickImpactSnippet(items) {
    const preferred = items.find((i) => i.category === "results_impact" && i.content) ??
        items.find((i) => i.category === "past_events" && i.content) ??
        items.find((i) => i.category === "stories_testimonials" && i.content);
    const text = preferred?.content?.trim();
    if (!text)
        return null;
    return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}
function pickPromotionChannels(items) {
    const out = { facebookUrl: "", instagramHandle: "", websiteUrl: "" };
    for (const item of items.filter((i) => i.category === "social_links")) {
        const blob = `${item.title ?? ""} ${item.content ?? ""} ${item.sourceUrl ?? ""} ${item.assetUrl ?? ""}`;
        const lower = blob.toLowerCase();
        const urlMatch = blob.match(/https?:\/\/[^\s]+/i)?.[0]?.trim() ?? "";
        if (!out.facebookUrl && (lower.includes("facebook") || lower.includes("fb.com"))) {
            out.facebookUrl = urlMatch || item.sourceUrl?.trim() || "";
        }
        if (!out.instagramHandle && lower.includes("instagram")) {
            const handle = blob.match(/@[A-Za-z0-9._]+/)?.[0];
            out.instagramHandle =
                handle ||
                    (urlMatch.includes("instagram.com")
                        ? `@${urlMatch.replace(/\/$/, "").split("/").pop() ?? ""}`.replace(/^@@/, "@")
                        : "") ||
                    item.content?.trim() ||
                    "";
        }
        if (!out.websiteUrl && lower.includes("website") && urlMatch && !/facebook|instagram|twitter|linkedin/i.test(urlMatch)) {
            out.websiteUrl = urlMatch;
        }
    }
    return out;
}
function pickFeaturedImage(items) {
    const preferred = items.find((i) => i.category === "photos_images" && i.assetUrl) ??
        items.find((i) => i.category === "logos_brand" && i.assetUrl);
    return preferred?.assetUrl?.trim() || null;
}
//# sourceMappingURL=organization-library.js.map