"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeFeaturedYouTubeVideoUrl = normalizeFeaturedYouTubeVideoUrl;
exports.parseFeaturedYoutubeFromBody = parseFeaturedYoutubeFromBody;
const suggest_social_images_1 = require("./suggest-social-images");
function normalizeFeaturedYouTubeVideoUrl(url) {
    if (url == null)
        return null;
    const raw = String(url).trim();
    if (!raw)
        return null;
    const normalized = (0, suggest_social_images_1.normalizeYouTubeUrl)(raw);
    if (!normalized)
        return null;
    if (/youtube\.com\/watch\?v=[\w-]{6,}/i.test(normalized)) {
        return normalized;
    }
    if (/youtube\.com\/shorts\/[\w-]{6,}/i.test(normalized)) {
        return normalized;
    }
    return null;
}
function parseFeaturedYoutubeFromBody(body) {
    if (!Object.prototype.hasOwnProperty.call(body, "featuredYoutubeUrl")) {
        return { ok: true, value: undefined };
    }
    const raw = body.featuredYoutubeUrl;
    if (raw === undefined) {
        return { ok: true, value: undefined };
    }
    if (raw === null || String(raw).trim() === "") {
        return { ok: true, value: null };
    }
    const normalized = normalizeFeaturedYouTubeVideoUrl(String(raw));
    if (!normalized) {
        return {
            ok: false,
            error: "Featured YouTube URL must be a valid YouTube watch or Shorts link",
        };
    }
    return { ok: true, value: normalized };
}
//# sourceMappingURL=featured-youtube.js.map