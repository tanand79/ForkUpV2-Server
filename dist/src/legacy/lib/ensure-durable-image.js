"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDurableCampaignImageUrl = isDurableCampaignImageUrl;
exports.normalizeDurableCampaignImageUrl = normalizeDurableCampaignImageUrl;
exports.detectImageMimeFromBuffer = detectImageMimeFromBuffer;
exports.ensureDurableImageUrl = ensureDurableImageUrl;
exports.unwrapVenuePhotoProxyUrl = unwrapVenuePhotoProxyUrl;
exports.preferPhotoUrlsFirst = preferPhotoUrlsFirst;
exports.ensureDurableVenueGalleryUrls = ensureDurableVenueGalleryUrls;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const s3_1 = require("./s3");
function imageContentHash(buffer) {
    return crypto_1.default.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}
const MAX_BYTES = 8 * 1024 * 1024;
const VENUE_GALLERY_MAX_BYTES = 16 * 1024 * 1024;
const VENUE_GALLERY_MIN_BYTES = 20 * 1024;
const FETCH_MS = 15_000;
function isDurableCampaignImageUrl(url) {
    const trimmed = url.trim();
    if (!trimmed)
        return false;
    if ((0, s3_1.isS3Ref)(trimmed))
        return true;
    if (trimmed.startsWith("/uploads/"))
        return true;
    try {
        if (/^https?:\/\//i.test(trimmed)) {
            const u = new URL(trimmed);
            if (u.pathname.startsWith("/uploads/"))
                return true;
        }
    }
    catch {
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed))
        return true;
    return false;
}
function normalizeDurableCampaignImageUrl(url) {
    const trimmed = url.trim();
    if ((0, s3_1.isS3Ref)(trimmed) || trimmed.startsWith("/uploads/"))
        return trimmed;
    try {
        if (/^https?:\/\//i.test(trimmed)) {
            const u = new URL(trimmed);
            if (u.pathname.startsWith("/uploads/"))
                return u.pathname;
        }
    }
    catch {
    }
    return trimmed;
}
function mimeFromHeaders(contentType, url) {
    const ct = (contentType || "").split(";")[0]?.trim().toLowerCase() || "";
    if (ct.startsWith("image/"))
        return ct;
    const lower = url.toLowerCase();
    if (lower.includes(".png"))
        return "image/png";
    if (lower.includes(".webp"))
        return "image/webp";
    if (lower.includes(".gif"))
        return "image/gif";
    return "image/jpeg";
}
function detectImageMimeFromBuffer(buffer) {
    if (!buffer || buffer.length < 3)
        return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47) {
        return "image/png";
    }
    if (buffer.length >= 6 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38 &&
        (buffer[4] === 0x39 || buffer[4] === 0x37) &&
        buffer[5] === 0x61) {
        return "image/gif";
    }
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50) {
        return "image/webp";
    }
    return null;
}
function saveImageToDisk(buffer, mimeType, prefix) {
    const dir = path_1.default.join(process.cwd(), "uploads", prefix);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const ext = mimeType.includes("png")
        ? "png"
        : mimeType.includes("webp")
            ? "webp"
            : mimeType.includes("gif")
                ? "gif"
                : "jpg";
    const filename = `${prefix.slice(0, -1) || "img"}-${imageContentHash(buffer)}.${ext}`;
    const filepath = path_1.default.join(dir, filename);
    if (!fs_1.default.existsSync(filepath)) {
        fs_1.default.writeFileSync(filepath, buffer);
    }
    return `/uploads/${prefix}/${filename}`;
}
async function ensureDurableImageUrl(imageUrl, prefix = "covers", options) {
    const trimmed = imageUrl.trim();
    if (!trimmed || trimmed.startsWith("blob:") || trimmed.startsWith("data:")) {
        throw new Error("Image URL is not durable");
    }
    if (isDurableCampaignImageUrl(trimmed)) {
        return normalizeDurableCampaignImageUrl(trimmed);
    }
    if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error("Unsupported image URL");
    }
    const res = await fetch(trimmed, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_MS),
        headers: {
            Accept: "image/*,*/*;q=0.8",
            "User-Agent": "ForkUp-ImageMirror/1.0",
            ...(options?.headers || {}),
        },
    });
    if (!res.ok) {
        throw new Error(`Failed to download image (${res.status})`);
    }
    const headerCt = (res.headers.get("content-type") || "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
    if (headerCt && (headerCt.startsWith("text/") || headerCt.includes("html") || headerCt.includes("json"))) {
        throw new Error(`URL did not return an image (content-type ${headerCt})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error("Downloaded image was empty");
    }
    const magicMime = detectImageMimeFromBuffer(buffer);
    if (!magicMime) {
        throw new Error("Downloaded bytes are not a JPEG/PNG/GIF/WEBP image");
    }
    const mime = magicMime;
    const minBytes = options?.minBytes ?? 0;
    if (minBytes > 0 && buffer.length < minBytes) {
        throw new Error(`Image too small to store as gallery photo (${buffer.length} bytes)`);
    }
    const maxBytes = options?.maxBytes ?? MAX_BYTES;
    if (buffer.length > maxBytes) {
        throw new Error("Image is too large to store");
    }
    if ((0, s3_1.isS3Enabled)()) {
        try {
            return await (0, s3_1.uploadImageToS3)(buffer, mime, prefix);
        }
        catch (err) {
            console.warn("S3 re-host failed; saving image to local disk instead:", err);
        }
    }
    return saveImageToDisk(buffer, mime, prefix);
}
function unwrapVenuePhotoProxyUrl(url) {
    const trimmed = (url || "").trim();
    if (!trimmed)
        return trimmed;
    try {
        const parsed = trimmed.startsWith("http")
            ? new URL(trimmed)
            : new URL(trimmed, "http://localhost");
        if (/venue-photo-proxy/i.test(parsed.pathname)) {
            const inner = parsed.searchParams.get("url")?.trim() || "";
            if (/^https?:\/\//i.test(inner))
                return inner;
        }
    }
    catch {
    }
    return trimmed;
}
function preferLargerPublicImageUrl(url) {
    const trimmed = (url || "").trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed))
        return trimmed;
    try {
        const u = new URL(trimmed);
        if (/\/quality_auto\//i.test(u.pathname)) {
            u.pathname = u.pathname.replace(/\/quality_auto\//i, "/");
        }
        if (/wixstatic\.com$/i.test(u.hostname) && /\/v1\//i.test(u.pathname)) {
            u.pathname = u.pathname.replace(/\/v1\/.*$/i, "");
            u.search = "";
            return u.toString();
        }
        const w = Number(u.searchParams.get("w") || 0);
        if (w > 0 && w < 800) {
            u.searchParams.set("w", "1600");
        }
        const h = Number(u.searchParams.get("h") || 0);
        if (h > 0 && h < 600) {
            u.searchParams.set("h", "1200");
        }
        return u.toString();
    }
    catch {
        return trimmed;
    }
}
function contentHashFromDurableUrl(url) {
    const m = /venue-galler-([a-f0-9]{16})\./i.exec(url);
    return m?.[1]?.toLowerCase() || null;
}
function preferPhotoUrlsFirst(urls) {
    const score = (u) => {
        const lower = u.toLowerCase();
        if (/\.(jpe?g|webp)(\?|$)/i.test(lower))
            return 0;
        if (/\.gif(\?|$)/i.test(lower))
            return 1;
        if (/\.png(\?|$)/i.test(lower))
            return 2;
        return 3;
    };
    return [...urls].sort((a, b) => score(a) - score(b));
}
async function ensureDurableVenueGalleryUrls(urls) {
    const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
    if (list.length === 0)
        return [];
    const CONCURRENCY = 4;
    const out = [];
    const seenHashes = new Set();
    const remember = (durable) => {
        const fromName = contentHashFromDurableUrl(durable);
        if (fromName) {
            if (seenHashes.has(fromName))
                return null;
            seenHashes.add(fromName);
            return durable;
        }
        if (durable.startsWith("/uploads/")) {
            try {
                const abs = path_1.default.join(process.cwd(), durable.replace(/^\//, ""));
                const buf = fs_1.default.readFileSync(abs);
                const h = imageContentHash(buf);
                if (seenHashes.has(h))
                    return null;
                seenHashes.add(h);
            }
            catch {
            }
        }
        return durable;
    };
    const one = async (url) => {
        if (isDurableCampaignImageUrl(url) && !/venue-photo-proxy/i.test(url)) {
            if (url.startsWith("/uploads/")) {
                try {
                    const abs = path_1.default.join(process.cwd(), url.replace(/^\//, ""));
                    const st = fs_1.default.statSync(abs);
                    if (st.size > 0 && st.size < VENUE_GALLERY_MIN_BYTES) {
                        console.warn("ensureDurableVenueGalleryUrls drop tiny upload:", url, st.size);
                        return null;
                    }
                    const fd = fs_1.default.openSync(abs, "r");
                    try {
                        const head = Buffer.alloc(16);
                        const n = fs_1.default.readSync(fd, head, 0, 16, 0);
                        if (!detectImageMimeFromBuffer(head.subarray(0, n))) {
                            console.warn("ensureDurableVenueGalleryUrls drop non-image upload:", url);
                            return null;
                        }
                    }
                    finally {
                        fs_1.default.closeSync(fd);
                    }
                }
                catch {
                    return null;
                }
            }
            return remember(normalizeDurableCampaignImageUrl(url));
        }
        const fetchUrl = preferLargerPublicImageUrl(unwrapVenuePhotoProxyUrl(url));
        const resyHeaders = /image\.resy\.com|images\.resy\.com/i.test(fetchUrl)
            ? {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                Referer: "https://resy.com/",
                Origin: "https://resy.com",
            }
            : undefined;
        try {
            const durable = await ensureDurableImageUrl(fetchUrl, "venue-gallery", {
                headers: resyHeaders,
                maxBytes: VENUE_GALLERY_MAX_BYTES,
                minBytes: VENUE_GALLERY_MIN_BYTES,
            });
            return remember(durable);
        }
        catch (err) {
            console.warn("ensureDurableVenueGalleryUrls drop:", fetchUrl, err);
            return null;
        }
    };
    for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY);
        const done = await Promise.all(batch.map(one));
        for (const u of done) {
            if (u)
                out.push(u);
        }
    }
    return preferPhotoUrlsFirst([...new Set(out)]);
}
//# sourceMappingURL=ensure-durable-image.js.map