"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
exports.uniqueCampaignSlug = uniqueCampaignSlug;
function slugify(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
async function uniqueCampaignSlug(baseName, exists) {
    const base = slugify(baseName) || "campaign";
    let slug = base;
    let counter = 1;
    while (await exists(slug)) {
        slug = `${base}-${counter}`;
        counter += 1;
    }
    return slug;
}
//# sourceMappingURL=slug.js.map