"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectSocialPlatform = detectSocialPlatform;
exports.isLikelySocialPostUrl = isLikelySocialPostUrl;
exports.extractInstagramMediaFromHtml = extractInstagramMediaFromHtml;
exports.extractCaptionFromHtml = extractCaptionFromHtml;
exports.discoverPostUrlsFromHtml = discoverPostUrlsFromHtml;
exports.extractSingleSocialPost = extractSingleSocialPost;
exports.extractPostsFromProfileUrl = extractPostsFromProfileUrl;
exports.extractPostsFromSocialProfiles = extractPostsFromSocialProfiles;
const suggest_social_images_1 = require("./suggest-social-images");
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 1_500_000;
const DEFAULT_MAX_POSTS_PER_PROFILE = 4;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)));
}
function detectSocialPlatform(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
        if (host === "instagram.com" || host.endsWith(".instagram.com"))
            return "instagram";
        if (host === "facebook.com" ||
            host === "fb.com" ||
            host === "m.facebook.com" ||
            host === "fb.watch" ||
            host.endsWith(".facebook.com")) {
            return "facebook";
        }
        if (host === "linkedin.com" || host.endsWith(".linkedin.com"))
            return "linkedin";
        if (host === "twitter.com" || host === "x.com" || host === "mobile.twitter.com") {
            return "x";
        }
        if (host === "tiktok.com" || host.endsWith(".tiktok.com"))
            return "tiktok";
        if (host === "youtube.com" ||
            host === "youtu.be" ||
            host === "m.youtube.com" ||
            host.endsWith(".youtube.com")) {
            return "youtube";
        }
        return "unknown";
    }
    catch {
        return "unknown";
    }
}
function isLikelySocialPostUrl(url, platform) {
    const p = platform ?? detectSocialPlatform(url);
    try {
        const u = new URL(url);
        const path = u.pathname;
        switch (p) {
            case "instagram":
                return /\/(p|reel|tv)\/[^/]+/i.test(path);
            case "facebook":
                return (/\/(posts|photos|videos|watch|share|permalink\.php|story\.php)\b/i.test(path) ||
                    /story_fbid=/i.test(u.search) ||
                    /\/posts\/\d+/i.test(path));
            case "linkedin":
                return /\/(posts|feed\/update|pulse)\//i.test(path) || /urn:li:/i.test(url);
            case "x":
                return /\/status\/\d+/i.test(path);
            case "tiktok":
                return /\/video\/\d+/i.test(path) || /\/@[^/]+\/video\/\d+/i.test(path);
            case "youtube":
                return (/[?&]v=[\w-]{6,}/i.test(u.search) ||
                    /^\/(watch|shorts|embed)\//i.test(path) ||
                    (u.hostname.includes("youtu.be") && path.length > 1));
            default:
                return false;
        }
    }
    catch {
        return false;
    }
}
async function fetchHtml(url, userAgent = BROWSER_UA) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": userAgent,
                Accept: "text/html,application/xhtml+xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "no-cache",
            },
        });
        if (res.status === 401 || res.status === 403) {
            return { html: null, status: res.status };
        }
        if (!res.ok)
            return { html: null, status: res.status };
        const ctype = res.headers.get("content-type") || "";
        if (ctype && !/html|text|xml|json/i.test(ctype) && !ctype.includes("octet-stream")) {
            return { html: null, status: res.status };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.length > MAX_HTML_BYTES
            ? buf.subarray(0, MAX_HTML_BYTES).toString("utf8")
            : buf.toString("utf8");
        return { html: text, status: res.status };
    }
    catch {
        return { html: null, status: null };
    }
    finally {
        clearTimeout(timer);
    }
}
function uaForPlatform(platform) {
    return platform === "instagram" || platform === "facebook" ? MOBILE_UA : BROWSER_UA;
}
function looksLikeLoginWall(html) {
    if (/polaris_timeline_connection|image_versions2|profile_pic_url|"og:image"/i.test(html)) {
        return false;
    }
    return /log\s*in\s*to\s*continue|must\s*log\s*in|create\s*an\s*account\s*to\s*continue|consent[_-]?required|checkpoint\/block/i.test(html);
}
function decodeEscapedMediaUrl(raw) {
    return decodeHtmlEntities(raw
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u00253D/gi, "=")
        .replace(/%3D/gi, "="));
}
function igMediaIdentity(url) {
    const key = /ig_cache_key=([^&]+)/i.exec(url)?.[1];
    if (key) {
        try {
            return decodeURIComponent(key);
        }
        catch {
            return key;
        }
    }
    try {
        return new URL(url).pathname;
    }
    catch {
        return url.split("?")[0] || url;
    }
}
function igSizeScore(url) {
    const dim = /_s(\d+)x(\d+)/i.exec(url);
    if (dim)
        return Number(dim[1]) * Number(dim[2]);
    if (/stp=dst-jpg_e15_tt6/i.test(url) && !/_s\d+x\d+/i.test(url))
        return 2_000_000;
    return 100;
}
function extractInstagramMediaFromHtml(html, maxImages) {
    const candidates = [];
    const re = /"url"\s*:\s*"(https:\\\/\\\/[^"]+(?:cdninstagram|fbcdn|scontent|instagram\.[^"]+)[^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const url = decodeEscapedMediaUrl(m[1] || "");
        if (!url)
            continue;
        if (/rsrc\.php|\.(?:js|css)(\?|$)/i.test(url))
            continue;
        if (!/\.(jpe?g|png|webp)/i.test(url) && !/stp=dst-jpg/i.test(url))
            continue;
        candidates.push(url);
    }
    const profileRe = /"profile_pic_url(?:_hd)?"\s*:\s*"(https:\\\/\\\/[^"]+)"/gi;
    while ((m = profileRe.exec(html)) !== null) {
        candidates.push(decodeEscapedMediaUrl(m[1] || ""));
    }
    const bestById = new Map();
    for (const url of candidates) {
        const id = igMediaIdentity(url);
        const prev = bestById.get(id);
        if (!prev || igSizeScore(url) > igSizeScore(prev)) {
            bestById.set(id, url);
        }
    }
    const all = [...bestById.values()];
    const posts = all.filter((u) => !/t51\.2885-19|profile_pic|s150x150|s100x100/i.test(u));
    const profiles = all.filter((u) => /t51\.2885-19|profile_pic|s150x150|s100x100/i.test(u));
    return [...posts, ...profiles].slice(0, Math.max(1, maxImages));
}
function extractCaptionFromHtml(html) {
    const patterns = [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
        /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:description["']/i,
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    ];
    for (const re of patterns) {
        const m = re.exec(html);
        if (m?.[1]) {
            const text = decodeHtmlEntities(m[1].trim());
            if (text)
                return text.slice(0, 2000);
        }
    }
    return null;
}
function absolutizePostUrl(raw, base) {
    try {
        const abs = new URL(raw, base).toString().split("#")[0] || null;
        return abs;
    }
    catch {
        return null;
    }
}
function discoverPostUrlsFromHtml(profileUrl, platform, html, maxPosts) {
    const found = [];
    const push = (raw) => {
        if (!raw || found.length >= maxPosts)
            return;
        const abs = absolutizePostUrl(decodeHtmlEntities(raw.trim()), profileUrl);
        if (!abs)
            return;
        if (!isLikelySocialPostUrl(abs, platform))
            return;
        const key = abs.replace(/\/+$/, "").toLowerCase();
        if (found.some((u) => u.replace(/\/+$/, "").toLowerCase() === key))
            return;
        found.push(abs.split("?")[0] || abs);
    };
    const hrefRe = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null && found.length < maxPosts) {
        push(m[1]);
    }
    const barePatterns = [];
    switch (platform) {
        case "instagram":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.)?instagram\.com\\?\/(?:p|reel|tv)\\?\/[A-Za-z0-9_-]+/gi);
            break;
        case "facebook":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.|m\.)?facebook\.com\\?\/[^"'\\\s]+(?:posts|photos|videos|permalink\.php)[^"'\\\s]*/gi);
            break;
        case "linkedin":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.)?linkedin\.com\\?\/(?:posts|feed\\?\/update)\\?\/[^"'\\\s]+/gi);
            break;
        case "x":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.)?(?:twitter|x)\.com\\?\/[^/"'\\\s]+\\?\/status\\?\/\d+/gi);
            break;
        case "tiktok":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.)?tiktok\.com\\?\/@[^/"'\\\s]+\\?\/video\\?\/\d+/gi);
            break;
        case "youtube":
            barePatterns.push(/https?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/watch\?v=[\w-]{6,}/gi, /https?:\\?\/\\?\/youtu\.be\\?\/[\w-]{6,}/gi, /https?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/shorts\\?\/[\w-]{6,}/gi);
            break;
        default:
            break;
    }
    for (const re of barePatterns) {
        let bm;
        while ((bm = re.exec(html)) !== null && found.length < maxPosts) {
            const cleaned = (bm[0] || "").replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
            push(cleaned);
        }
    }
    return found.slice(0, maxPosts);
}
async function fetchMicrolinkMeta(pageUrl) {
    const apiKey = process.env.MICROLINK_API_KEY?.trim();
    if (!apiKey)
        return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const endpoint = new URL("https://api.microlink.io");
        endpoint.searchParams.set("url", pageUrl);
        endpoint.searchParams.set("meta", "true");
        endpoint.searchParams.set("apiKey", apiKey);
        const res = await fetch(endpoint.toString(), {
            method: "GET",
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        if (body.status !== "success" || !body.data)
            return null;
        const caption = trimStr(body.data.description) || trimStr(body.data.title) || null;
        const imageUrls = [];
        const img = body.data.image;
        if (typeof img === "string" && /^https?:\/\//i.test(img))
            imageUrls.push(img);
        else if (img && typeof img === "object" && typeof img.url === "string") {
            if (/^https?:\/\//i.test(img.url))
                imageUrls.push(img.url);
        }
        return { caption, imageUrls };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchPublicOEmbed(postUrl, platform) {
    let api = null;
    switch (platform) {
        case "youtube":
            api = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(postUrl)}`;
            break;
        case "tiktok":
            api = `https://www.tiktok.com/oembed?url=${encodeURIComponent(postUrl)}`;
            break;
        case "x":
            api = `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(postUrl)}`;
            break;
        default:
            return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(api, {
            method: "GET",
            signal: controller.signal,
            headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        const caption = trimStr(body.title) ||
            (trimStr(body.author_name) ? `Post by ${trimStr(body.author_name)}` : null);
        const imageUrls = [];
        if (body.thumbnail_url && /^https?:\/\//i.test(body.thumbnail_url)) {
            imageUrls.push(body.thumbnail_url);
        }
        if (!imageUrls.length && body.html) {
            const imgM = /src=["'](https?:\/\/[^"']+)["']/i.exec(body.html);
            if (imgM?.[1])
                imageUrls.push(imgM[1]);
        }
        return { caption, imageUrls };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function extractYouTubeChannelPosts(channelUrl, maxPosts) {
    const { html } = await fetchHtml(channelUrl);
    if (!html) {
        return [
            {
                platform: "youtube",
                postUrl: channelUrl,
                profileUrl: channelUrl,
                caption: null,
                imageUrls: [],
                status: "unavailable",
            },
        ];
    }
    let channelId = null;
    const idPatterns = [
        /"channelId"\s*:\s*"(UC[\w-]{20,})"/,
        /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[\w-]{20,})["']/i,
        /youtube\.com\/channel\/(UC[\w-]{20,})/i,
    ];
    for (const re of idPatterns) {
        const m = re.exec(html);
        if (m?.[1]) {
            channelId = m[1];
            break;
        }
    }
    if (!channelId) {
        const postUrls = discoverPostUrlsFromHtml(channelUrl, "youtube", html, maxPosts);
        const out = [];
        for (const postUrl of postUrls) {
            out.push(await extractSingleSocialPost(postUrl, channelUrl));
        }
        if (out.length === 0) {
            out.push(await extractSingleSocialPost(channelUrl, channelUrl));
        }
        return out;
    }
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const feed = await fetchHtml(feedUrl);
    if (!feed.html) {
        return [await extractSingleSocialPost(channelUrl, channelUrl)];
    }
    const entries = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
    let em;
    while ((em = entryRe.exec(feed.html)) !== null && entries.length < maxPosts) {
        const entry = em[1] || "";
        const linkM = /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i.exec(entry) ||
            /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["']/i.exec(entry);
        const titleM = /<title>([^<]*)<\/title>/i.exec(entry);
        const thumbM = /<media:thumbnail[^>]+url=["']([^"']+)["']/i.exec(entry) ||
            /url=["'](https?:\/\/i\.ytimg\.com[^"']+)["']/i.exec(entry);
        const descM = /<media:description>([\s\S]*?)<\/media:description>/i.exec(entry);
        const postUrl = linkM?.[1]?.trim();
        if (!postUrl)
            continue;
        const caption = trimStr(descM?.[1] ? decodeHtmlEntities(descM[1]).slice(0, 500) : "") ||
            trimStr(titleM?.[1] ? decodeHtmlEntities(titleM[1]) : "") ||
            null;
        const imageUrls = thumbM?.[1] ? [thumbM[1]] : [];
        entries.push({
            platform: "youtube",
            postUrl,
            profileUrl: channelUrl,
            caption,
            imageUrls,
            status: imageUrls.length > 0 ? "ok" : caption ? "no_images" : "unavailable",
        });
    }
    if (entries.length === 0) {
        return [await extractSingleSocialPost(channelUrl, channelUrl)];
    }
    return entries;
}
function rankAndFilterImages(urls) {
    const seen = new Set();
    const photos = [];
    const logos = [];
    const sorted = [...urls].sort((a, b) => (0, suggest_social_images_1.photoCoverRank)(a) - (0, suggest_social_images_1.photoCoverRank)(b));
    for (const url of sorted) {
        const key = url.split("?")[0].toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        if ((0, suggest_social_images_1.looksLikeLogoUrl)(url))
            logos.push(url);
        else
            photos.push(url);
    }
    return (photos.length > 0 ? photos : logos).slice(0, 8);
}
async function extractSingleSocialPost(postUrl, profileUrl = null) {
    const platform = detectSocialPlatform(postUrl);
    if (platform === "unknown") {
        return {
            platform,
            postUrl,
            profileUrl,
            caption: null,
            imageUrls: [],
            status: "unsupported",
        };
    }
    const micro = await fetchMicrolinkMeta(postUrl);
    if (micro && (micro.imageUrls.length > 0 || micro.caption)) {
        const imageUrls = rankAndFilterImages(micro.imageUrls);
        return {
            platform,
            postUrl,
            profileUrl,
            caption: micro.caption,
            imageUrls,
            status: imageUrls.length > 0 ? "ok" : "no_images",
        };
    }
    const oembed = await fetchPublicOEmbed(postUrl, platform);
    if (oembed && (oembed.imageUrls.length > 0 || oembed.caption)) {
        const imageUrls = rankAndFilterImages(oembed.imageUrls);
        return {
            platform,
            postUrl,
            profileUrl,
            caption: oembed.caption,
            imageUrls,
            status: imageUrls.length > 0 ? "ok" : "no_images",
        };
    }
    const { html, status } = await fetchHtml(postUrl, uaForPlatform(platform));
    if (!html) {
        return {
            platform,
            postUrl,
            profileUrl,
            caption: null,
            imageUrls: [],
            status: status === 401 || status === 403 ? "private" : "unavailable",
        };
    }
    if (looksLikeLoginWall(html)) {
        return {
            platform,
            postUrl,
            profileUrl,
            caption: null,
            imageUrls: [],
            status: "private",
        };
    }
    const caption = extractCaptionFromHtml(html);
    let rawImages = platform === "instagram"
        ? extractInstagramMediaFromHtml(html, 12)
        : (0, suggest_social_images_1.extractImageUrlsFromHtml)(html, postUrl);
    if (rawImages.length === 0) {
        rawImages = (0, suggest_social_images_1.extractImageUrlsFromHtml)(html, postUrl);
    }
    const imageUrls = rankAndFilterImages(rawImages);
    if (imageUrls.length === 0 && !caption) {
        return {
            platform,
            postUrl,
            profileUrl,
            caption: null,
            imageUrls: [],
            status: "unavailable",
        };
    }
    return {
        platform,
        postUrl,
        profileUrl,
        caption,
        imageUrls,
        status: imageUrls.length > 0 ? "ok" : "no_images",
    };
}
async function extractPostsFromProfileUrl(profileUrl, maxPosts = DEFAULT_MAX_POSTS_PER_PROFILE) {
    const platform = detectSocialPlatform(profileUrl);
    if (platform === "unknown") {
        return [
            {
                platform,
                postUrl: profileUrl,
                profileUrl,
                caption: null,
                imageUrls: [],
                status: "unsupported",
            },
        ];
    }
    if (isLikelySocialPostUrl(profileUrl, platform)) {
        return [await extractSingleSocialPost(profileUrl, null)];
    }
    if (platform === "youtube") {
        return extractYouTubeChannelPosts(profileUrl, maxPosts);
    }
    const { html, status } = await fetchHtml(profileUrl, uaForPlatform(platform));
    if (!html) {
        return [
            {
                platform,
                postUrl: profileUrl,
                profileUrl,
                caption: null,
                imageUrls: [],
                status: status === 401 || status === 403 ? "private" : "unavailable",
            },
        ];
    }
    if (platform === "instagram") {
        const caption = extractCaptionFromHtml(html);
        const media = extractInstagramMediaFromHtml(html, Math.max(maxPosts * 3, 10));
        if (media.length > 0) {
            return media.slice(0, maxPosts).map((imageUrl, idx) => ({
                platform,
                postUrl: profileUrl,
                profileUrl,
                caption: idx === 0 ? caption : null,
                imageUrls: [imageUrl],
                status: "ok",
            }));
        }
    }
    if (looksLikeLoginWall(html)) {
        const fallback = await extractSingleSocialPost(profileUrl, profileUrl);
        if (fallback.status === "ok" || fallback.status === "no_images") {
            return [{ ...fallback, status: fallback.imageUrls.length ? "ok" : "private" }];
        }
        return [
            {
                platform,
                postUrl: profileUrl,
                profileUrl,
                caption: null,
                imageUrls: [],
                status: "private",
            },
        ];
    }
    if (platform === "facebook") {
        const caption = extractCaptionFromHtml(html);
        const imageUrls = rankAndFilterImages((0, suggest_social_images_1.extractImageUrlsFromHtml)(html, profileUrl));
        if (imageUrls.length > 0) {
            return imageUrls.slice(0, maxPosts).map((imageUrl, idx) => ({
                platform,
                postUrl: profileUrl,
                profileUrl,
                caption: idx === 0 ? caption : null,
                imageUrls: [imageUrl],
                status: "ok",
            }));
        }
    }
    const postUrls = discoverPostUrlsFromHtml(profileUrl, platform, html, maxPosts);
    if (postUrls.length === 0) {
        return [await extractSingleSocialPost(profileUrl, profileUrl)];
    }
    const results = [];
    for (const postUrl of postUrls) {
        results.push(await extractSingleSocialPost(postUrl, profileUrl));
    }
    return results;
}
async function extractPostsFromSocialProfiles(input) {
    const maxPosts = Math.min(8, Math.max(1, input.maxPostsPerProfile ?? DEFAULT_MAX_POSTS_PER_PROFILE));
    const profiles = [
        trimStr(input.facebookUrl),
        trimStr(input.instagramUrl),
        trimStr(input.linkedinUrl),
        trimStr(input.youtubeUrl),
        trimStr(input.xUrl),
        trimStr(input.tiktokUrl),
    ].filter(Boolean);
    if (profiles.length === 0)
        return [];
    const batches = await Promise.all(profiles.map((url) => extractPostsFromProfileUrl(url, maxPosts)));
    return batches.flat();
}
//# sourceMappingURL=extract-social-posts.js.map