"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDurableCampaignImageUrl = isDurableCampaignImageUrl;
exports.normalizeDurableCampaignImageUrl = normalizeDurableCampaignImageUrl;
exports.ensureDurableImageUrl = ensureDurableImageUrl;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const s3_1 = require("./s3");
const MAX_BYTES = 8 * 1024 * 1024;
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
    const filename = `${prefix.slice(0, -1) || "img"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs_1.default.writeFileSync(path_1.default.join(dir, filename), buffer);
    return `/uploads/${prefix}/${filename}`;
}
async function ensureDurableImageUrl(imageUrl, prefix = "covers") {
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
        },
    });
    if (!res.ok) {
        throw new Error(`Failed to download image (${res.status})`);
    }
    const mime = mimeFromHeaders(res.headers.get("content-type"), trimmed);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error("Downloaded image was empty");
    }
    if (buffer.length > MAX_BYTES) {
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
//# sourceMappingURL=ensure-durable-image.js.map