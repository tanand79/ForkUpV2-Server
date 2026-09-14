"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeLogoUrl = looksLikeLogoUrl;
exports.photoCoverRank = photoCoverRank;
exports.normalizeInstagramUrl = normalizeInstagramUrl;
exports.normalizeFacebookUrl = normalizeFacebookUrl;
exports.normalizeLinkedInUrl = normalizeLinkedInUrl;
exports.normalizeYouTubeUrl = normalizeYouTubeUrl;
exports.normalizeWebsiteUrl = normalizeWebsiteUrl;
exports.extractImageUrlsFromHtml = extractImageUrlsFromHtml;
exports.extractSocialLinksFromHtml = extractSocialLinksFromHtml;
exports.discoverSocialLinksFromWebsite = discoverSocialLinksFromWebsite;
exports.suggestSocialImages = suggestSocialImages;
const DEFAULT_LIMIT = 6;
const MAX_SUGGEST_LIMIT = 10;
const CANDIDATE_POOL = 30;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}
function looksLikeLogoUrl(url) {
    const raw = (url || "").trim();
    if (!raw)
        return false;
    if (/\.svg(\?|$)/i.test(raw))
        return true;
    if (/static\.licdn\.com\/aero/i.test(raw))
        return true;
    return /logo|icon|favicon|avatar|profile[_-]?pic|wordmark|seal|badge|sprite|emoji|brand[_-]?mark|webclip|apple[_-]?touch/i.test(raw);
}
function photoCoverRank(url) {
    const raw = (url || "").trim();
    if (!raw)
        return 999;
    if (looksLikeLogoUrl(raw))
        return 100;
    if (/hero|photo|portrait|team|gallery|donate|people|event|bg[-_]|[_-]bg|shoelace/i.test(raw)) {
        return 0;
    }
    if (/\.avif(\?|$)/i.test(raw))
        return 5;
    if (/\.(jpe?g|webp)(\?|$)/i.test(raw))
        return 10;
    if (/\.png(\?|$)/i.test(raw))
        return 25;
    return 15;
}
function normalizeInstagramUrl(handleOrUrl) {
    const raw = handleOrUrl.trim();
    if (!raw)
        return null;
    if (/^https?:\/\//i.test(raw)) {
        try {
            const u = new URL(raw);
            if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, "")))
                return null;
            return `https://www.instagram.com${u.pathname.replace(/\/+$/, "")}/`;
        }
        catch {
            return null;
        }
    }
    const handle = raw.replace(/^@/, "").replace(/\/+$/, "").split(/[/?#]/)[0];
    if (!handle || !/^[A-Za-z0-9._]+$/.test(handle))
        return null;
    return `https://www.instagram.com/${handle}/`;
}
function normalizeFacebookUrl(url) {
    const raw = url.trim();
    if (!raw)
        return null;
    try {
        let withProto = raw;
        if (!/^https?:\/\//i.test(withProto))
            withProto = `https://${withProto}`;
        const u = new URL(withProto);
        const host = u.hostname.replace(/^www\./, "").toLowerCase();
        if (host !== "facebook.com" && host !== "fb.com" && host !== "m.facebook.com") {
            return null;
        }
        return `https://www.facebook.com${u.pathname.replace(/\/+$/, "") || ""}`;
    }
    catch {
        return null;
    }
}
function normalizeLinkedInUrl(url) {
    const raw = url.trim();
    if (!raw)
        return null;
    try {
        let withProto = raw;
        if (!/^https?:\/\//i.test(withProto))
            withProto = `https://${withProto}`;
        const u = new URL(withProto);
        const host = u.hostname.replace(/^www\./, "").toLowerCase();
        if (host !== "linkedin.com")
            return null;
        const path = u.pathname.replace(/\/+$/, "") || "";
        if (!path || path === "/")
            return null;
        return `https://www.linkedin.com${path}`;
    }
    catch {
        return null;
    }
}
function normalizeYouTubeUrl(url) {
    const raw = url.trim();
    if (!raw || raw === "#" || raw.startsWith("#"))
        return null;
    try {
        let withProto = raw;
        if (!/^https?:\/\//i.test(withProto)) {
            if (raw.startsWith("@"))
                withProto = `https://www.youtube.com/${raw}`;
            else if (/^youtube\.com|^youtu\.be/i.test(raw))
                withProto = `https://${raw}`;
            else
                return null;
        }
        const u = new URL(withProto);
        const host = u.hostname.replace(/^www\./, "").toLowerCase();
        if (host !== "youtube.com" && host !== "youtu.be" && host !== "m.youtube.com") {
            return null;
        }
        if (host === "youtu.be") {
            const id = u.pathname.replace(/^\//, "").split("/")[0];
            if (!id)
                return null;
            return `https://www.youtube.com/watch?v=${id}`;
        }
        const path = u.pathname.replace(/\/+$/, "") || "";
        if (!path || path === "/")
            return null;
        return `https://www.youtube.com${path}${u.search || ""}`;
    }
    catch {
        return null;
    }
}
function isFacebookUtilityLink(url) {
    return /facebook\.com\/(sharer\.php|sharer\/|dialog\/|plugins\/)/i.test(url);
}
function normalizeWebsiteUrl(url) {
    const raw = url.trim();
    if (!raw)
        return null;
    try {
        let withProto = raw;
        if (!/^https?:\/\//i.test(withProto))
            withProto = `https://${withProto}`;
        const u = new URL(withProto);
        if (u.protocol !== "http:" && u.protocol !== "https:")
            return null;
        return u.toString();
    }
    catch {
        return null;
    }
}
function absUrl(base, maybeRelative) {
    try {
        return new URL(maybeRelative, base).toString();
    }
    catch {
        return null;
    }
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
function extractImageUrlsFromHtml(html, pageUrl) {
    const found = [];
    const push = (raw) => {
        if (!raw)
            return;
        const decoded = decodeHtmlEntities(raw.trim());
        if (!decoded || decoded.startsWith("data:"))
            return;
        const abs = absUrl(pageUrl, decoded);
        if (!abs || !/^https?:\/\//i.test(abs))
            return;
        if (!found.includes(abs))
            found.push(abs);
    };
    const metaPatterns = [
        /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/gi,
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
        /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/gi,
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/gi,
        /"image"\s*:\s*\{\s*"@type"\s*:\s*"ImageObject"[^}]*"url"\s*:\s*"([^"]+)"/gi,
        /"image"\s*:\s*"([^"]+)"/gi,
    ];
    for (const re of metaPatterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
            push(m[1]);
        }
    }
    const pageHost = (() => {
        try {
            return new URL(pageUrl).hostname.replace(/^www\./, "");
        }
        catch {
            return "";
        }
    })();
    const acceptHostedImage = (abs) => {
        try {
            const host = new URL(abs).hostname.replace(/^www\./, "");
            if (host === pageHost)
                return true;
            if (/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs))
                return true;
            return false;
        }
        catch {
            return false;
        }
    };
    try {
        const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
        let m;
        let imgAdded = 0;
        while ((m = imgRe.exec(html)) !== null && imgAdded < 24) {
            const abs = absUrl(pageUrl, m[1]);
            if (!abs)
                continue;
            if (/\.(svg)(\?|$)/i.test(abs))
                continue;
            if (/pixel|spacer|tracking|1x1|favicon|chevron|close[_-]?button/i.test(abs))
                continue;
            if (!acceptHostedImage(abs))
                continue;
            const before = found.length;
            push(abs);
            if (found.length > before)
                imgAdded += 1;
        }
    }
    catch {
    }
    try {
        const srcsetRe = /srcset=["']([^"']+)["']/gi;
        let sm;
        let srcsetAdded = 0;
        while ((sm = srcsetRe.exec(html)) !== null && srcsetAdded < 16) {
            const entries = sm[1]
                .split(",")
                .map((part) => part.trim().split(/\s+/)[0])
                .filter(Boolean);
            for (const cand of entries.reverse()) {
                const abs = absUrl(pageUrl, cand);
                if (!abs)
                    continue;
                if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs))
                    continue;
                if (/pixel|spacer|tracking|1x1|favicon|logo|icon/i.test(abs))
                    continue;
                if (!acceptHostedImage(abs))
                    continue;
                const before = found.length;
                push(abs);
                if (found.length > before) {
                    srcsetAdded += 1;
                    break;
                }
            }
        }
    }
    catch {
    }
    try {
        const cdnRe = /https?:\\?\/\\?\/[^\s"'<>\\]+(?:cdninstagram\.com|fbcdn\.net|scontent[^\s"'<>\\]*\.fbcdn\.net)[^\s"'<>\\]*/gi;
        let cm;
        let cdnAdded = 0;
        while ((cm = cdnRe.exec(html)) !== null && cdnAdded < 40) {
            const raw = (cm[0] || "").replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
            const cleaned = raw.split("?")[0] || raw;
            if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(cleaned) && !/\/[tp]\d+x\d+\//i.test(raw)) {
                if (!/cdninstagram|fbcdn|scontent/i.test(raw))
                    continue;
            }
            if (/profile|avatar|logo|emoji|static/i.test(raw))
                continue;
            const before = found.length;
            push(raw);
            if (found.length > before)
                cdnAdded += 1;
        }
    }
    catch {
    }
    return found.sort((a, b) => photoCoverRank(a) - photoCoverRank(b));
}
async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": BROWSER_UA,
                Accept: "text/html,application/xhtml+xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "no-cache",
            },
        });
        if (!res.ok)
            return null;
        const ctype = res.headers.get("content-type") || "";
        if (ctype && !/html|text|xml/i.test(ctype) && !ctype.includes("octet-stream")) {
            return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_HTML_BYTES) {
            return buf.subarray(0, MAX_HTML_BYTES).toString("utf8");
        }
        return buf.toString("utf8");
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function isReachableImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": BROWSER_UA,
                Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                Range: "bytes=0-1023",
            },
        });
        if (!(res.ok || res.status === 206))
            return false;
        const ctype = (res.headers.get("content-type") || "").toLowerCase();
        if (ctype.includes("text/html"))
            return false;
        if (ctype.startsWith("image/"))
            return true;
        return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url);
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
async function collectFromPage(pageUrl, source, out, limit) {
    if (out.length >= limit)
        return;
    const html = await fetchHtml(pageUrl);
    if (!html)
        return;
    for (const imageUrl of extractImageUrlsFromHtml(html, pageUrl)) {
        if (out.length >= limit)
            break;
        if (out.some((i) => i.url === imageUrl))
            continue;
        const ok = await isReachableImage(imageUrl);
        if (!ok)
            continue;
        out.push({ url: imageUrl, source, sourceUrl: pageUrl });
    }
}
function websiteUrlVariants(url) {
    try {
        const u = new URL(url);
        const host = u.hostname;
        const variants = [u.toString()];
        if (host.startsWith("www.")) {
            u.hostname = host.slice(4);
            variants.push(u.toString());
        }
        else {
            u.hostname = `www.${host}`;
            variants.push(u.toString());
        }
        return [...new Set(variants)];
    }
    catch {
        return [url];
    }
}
function extractSocialLinksFromHtml(html) {
    let facebookUrl = null;
    let instagramUrl = null;
    let linkedinUrl = null;
    let youtubeUrl = null;
    const candidates = [];
    const hrefRe = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
        if (m[1])
            candidates.push(decodeHtmlEntities(m[1].trim()));
    }
    const bareRe = /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|m\.facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be)\/[^\s"'<>]+/gi;
    while ((m = bareRe.exec(html)) !== null) {
        if (m[0])
            candidates.push(m[0].replace(/[),.;]+$/, ""));
    }
    for (const raw of candidates) {
        if (!facebookUrl) {
            const fb = normalizeFacebookUrl(raw);
            if (fb && !isFacebookUtilityLink(fb)) {
                facebookUrl = fb;
            }
        }
        if (!instagramUrl) {
            const ig = normalizeInstagramUrl(raw);
            if (ig && !/instagram\.com\/(p|reel|stories|explore)\b/i.test(ig)) {
                instagramUrl = ig;
            }
        }
        if (!linkedinUrl) {
            const li = normalizeLinkedInUrl(raw);
            if (li && !/linkedin\.com\/(shareArticle|sharing)\b/i.test(li)) {
                linkedinUrl = li;
            }
        }
        if (!youtubeUrl) {
            const yt = normalizeYouTubeUrl(raw);
            if (yt)
                youtubeUrl = yt;
        }
        if (facebookUrl && instagramUrl && linkedinUrl && youtubeUrl)
            break;
    }
    return { facebookUrl, instagramUrl, linkedinUrl, youtubeUrl };
}
async function discoverSocialLinksFromWebsite(websiteUrl) {
    const empty = {
        facebookUrl: null,
        instagramUrl: null,
        linkedinUrl: null,
        youtubeUrl: null,
    };
    const normalized = normalizeWebsiteUrl(websiteUrl);
    if (!normalized)
        return empty;
    for (const variant of websiteUrlVariants(normalized)) {
        const html = await fetchHtml(variant);
        if (!html)
            continue;
        const found = extractSocialLinksFromHtml(html);
        if (found.facebookUrl || found.instagramUrl || found.linkedinUrl || found.youtubeUrl) {
            return found;
        }
    }
    return empty;
}
function suggestedSourceForPlatform(platform) {
    if (platform === "facebook")
        return "facebook";
    if (platform === "instagram")
        return "instagram";
    return "social_suggest";
}
function suggestedChannelRank(img) {
    if (img.source === "instagram")
        return 0;
    if (img.source === "facebook")
        return 10;
    if (img.source === "social_suggest") {
        const ref = `${img.sourceUrl || ""} ${img.url || ""}`;
        if (/linkedin\.com|licdn\.com/i.test(ref))
            return 20;
        if (/youtube\.com|youtu\.be|ytimg\.com/i.test(ref))
            return 30;
        return 35;
    }
    if (img.source === "website")
        return 40;
    return 50;
}
async function appendImagesFromProfilePosts(profileUrl, maxPosts, out, poolLimit) {
    if (!profileUrl || out.length >= poolLimit)
        return;
    try {
        const { extractPostsFromProfileUrl } = await import("./extract-social-posts.js");
        const posts = await extractPostsFromProfileUrl(profileUrl, maxPosts);
        for (const post of posts) {
            if (out.length >= poolLimit)
                break;
            if (post.status !== "ok" && post.status !== "no_images")
                continue;
            for (const imageUrl of post.imageUrls) {
                if (out.length >= poolLimit)
                    break;
                if (out.some((i) => i.url === imageUrl))
                    continue;
                const ok = await isReachableImage(imageUrl);
                if (!ok)
                    continue;
                out.push({
                    url: imageUrl,
                    source: suggestedSourceForPlatform(post.platform),
                    sourceUrl: post.postUrl || post.profileUrl,
                    caption: post.caption,
                });
            }
        }
    }
    catch {
    }
}
async function suggestSocialImages(input) {
    const limit = Math.min(MAX_SUGGEST_LIMIT, Math.max(1, Number.isFinite(input.limit) ? Number(input.limit) : DEFAULT_LIMIT));
    const poolLimit = Math.min(CANDIDATE_POOL, Math.max(limit * 3, limit));
    const out = [];
    const website = normalizeWebsiteUrl(trimStr(input.websiteUrl));
    const facebook = normalizeFacebookUrl(trimStr(input.facebookUrl));
    const instagram = normalizeInstagramUrl(trimStr(input.instagramHandle));
    const linkedin = normalizeLinkedInUrl(trimStr(input.linkedinUrl));
    const youtube = normalizeYouTubeUrl(trimStr(input.youtubeUrl));
    const hasSocial = Boolean(facebook || instagram || linkedin || youtube);
    if (hasSocial) {
        await appendImagesFromProfilePosts(instagram, 8, out, poolLimit);
        await appendImagesFromProfilePosts(facebook, 4, out, poolLimit);
        await appendImagesFromProfilePosts(linkedin, 4, out, poolLimit);
        await appendImagesFromProfilePosts(youtube, 4, out, poolLimit);
    }
    if (hasSocial && out.length < poolLimit) {
        if (instagram)
            await collectFromPage(instagram, "instagram", out, poolLimit);
        if (facebook)
            await collectFromPage(facebook, "facebook", out, poolLimit);
    }
    if (website && out.length === 0) {
        for (const variant of websiteUrlVariants(website)) {
            if (out.length >= poolLimit)
                break;
            await collectFromPage(variant, "website", out, poolLimit);
        }
    }
    out.sort((a, b) => {
        const channel = suggestedChannelRank(a) - suggestedChannelRank(b);
        if (channel !== 0)
            return channel;
        return photoCoverRank(a.url) - photoCoverRank(b.url);
    });
    return out.slice(0, limit);
}
//# sourceMappingURL=suggest-social-images.js.map