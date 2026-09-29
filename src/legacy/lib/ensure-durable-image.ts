/**
 * Ensure campaign cover / gallery image URLs are durable for public pages.
 *
 * Purpose: Remote social/CDN hotlinks expire or block embedding. When a save
 * path receives http(s) that is not already our `/uploads/…` mount, download
 * the bytes and re-host to S3 (`s3://…`) or local disk (`/uploads/…`).
 *
 * Inputs:
 *   - imageUrl: candidate URL from the client or an existing DB value
 *   - prefix: storage folder under covers/logos/… (default "covers")
 *
 * Outputs:
 *   - Durable stored reference: `s3://<key>`, `/uploads/…`, or unchanged
 *     seed/preset filename (e.g. campaign-animals.jpg).
 *
 * Throws when the URL is empty/blob/data, download fails, or the body is not
 * a usable image (so callers can return 400 instead of persisting hotlinks).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isS3Enabled, isS3Ref, uploadImageToS3 } from "./s3";

/** Short content hash so identical bytes reuse one on-disk file. */
function imageContentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

const MAX_BYTES = 8 * 1024 * 1024;
/** Venue gallery originals (Resy) can exceed campaign-cover size. */
const VENUE_GALLERY_MAX_BYTES = 16 * 1024 * 1024;
/** Skip tiny thumbs that blur when used as cover (seen ~3KB on Don Camaron). */
const VENUE_GALLERY_MIN_BYTES = 20 * 1024;
const FETCH_MS = 15_000;

/**
 * True when the value can be stored as-is without re-hosting.
 * Inputs: candidate URL. Outputs: boolean.
 */
export function isDurableCampaignImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (isS3Ref(trimmed)) return true;
  if (trimmed.startsWith("/uploads/")) return true;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      if (u.pathname.startsWith("/uploads/")) return true;
    }
  } catch {
    /* ignore invalid URL */
  }
  // Relative/preset filenames used by seed + web resolveCampaignImage (no scheme).
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return true;
  return false;
}

/**
 * Normalize durable absolute `/uploads/…` URLs down to a path-only reference.
 * Inputs: durable candidate. Outputs: storage string for DB.
 */
export function normalizeDurableCampaignImageUrl(url: string): string {
  const trimmed = url.trim();
  if (isS3Ref(trimmed) || trimmed.startsWith("/uploads/")) return trimmed;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      if (u.pathname.startsWith("/uploads/")) return u.pathname;
    }
  } catch {
    /* ignore */
  }
  return trimmed;
}

function mimeFromHeaders(contentType: string | null, url: string): string {
  const ct = (contentType || "").split(";")[0]?.trim().toLowerCase() || "";
  if (ct.startsWith("image/")) return ct;
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Writes image bytes under uploads/<prefix>/ when S3 is unavailable.
 * Inputs: buffer, mime, prefix. Outputs: `/uploads/<prefix>/<file>` path.
 */
function saveImageToDisk(buffer: Buffer, mimeType: string, prefix: string): string {
  const dir = path.join(process.cwd(), "uploads", prefix);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mimeType.includes("png")
    ? "png"
    : mimeType.includes("webp")
      ? "webp"
      : mimeType.includes("gif")
        ? "gif"
        : "jpg";
  // Hash-based name: re-hosting the same photo does not create another file.
  const filename = `${prefix.slice(0, -1) || "img"}-${imageContentHash(buffer)}.${ext}`;
  const filepath = path.join(dir, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, buffer);
  }
  return `/uploads/${prefix}/${filename}`;
}

/**
 * Re-host a remote image when needed; pass through durable values unchanged.
 * Inputs: imageUrl, optional storage prefix, optional fetch headers (e.g. Resy Referer).
 * Outputs: durable storage URL.
 */
export async function ensureDurableImageUrl(
  imageUrl: string,
  prefix = "covers",
  options?: {
    headers?: Record<string, string>;
    maxBytes?: number;
    minBytes?: number;
  },
): Promise<string> {
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

  const mime = mimeFromHeaders(res.headers.get("content-type"), trimmed);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("Downloaded image was empty");
  }
  const minBytes = options?.minBytes ?? 0;
  if (minBytes > 0 && buffer.length < minBytes) {
    throw new Error(
      `Image too small to store as gallery photo (${buffer.length} bytes)`,
    );
  }
  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  if (buffer.length > maxBytes) {
    throw new Error("Image is too large to store");
  }

  if (isS3Enabled()) {
    try {
      return await uploadImageToS3(buffer, mime, prefix);
    } catch (err) {
      console.warn("S3 re-host failed; saving image to local disk instead:", err);
    }
  }

  return saveImageToDisk(buffer, mime, prefix);
}

/**
 * Unwrap `/api/venue-photo-proxy?url=` back to the upstream https URL.
 * Inputs: stored or scraped gallery URL. Outputs: fetchable https URL (or original).
 */
export function unwrapVenuePhotoProxyUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = trimmed.startsWith("http")
      ? new URL(trimmed)
      : new URL(trimmed, "http://localhost");
    if (/venue-photo-proxy/i.test(parsed.pathname)) {
      const inner = parsed.searchParams.get("url")?.trim() || "";
      if (/^https?:\/\//i.test(inner)) return inner;
    }
  } catch {
    /* keep original */
  }
  return trimmed;
}

/**
 * Prefer a larger public variant when sites expose tiny thumbs via query/path.
 * Inputs: absolute image URL. Outputs: maybe-upgraded URL (same if unchanged).
 */
function preferLargerPublicImageUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    // "quality_auto" folders often serve compressed thumbs — try the raw media path.
    if (/\/quality_auto\//i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/quality_auto\//i, "/");
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
  } catch {
    return trimmed;
  }
}

/**
 * Re-host scraped venue gallery URLs into ForkUp storage (S3 or /uploads/).
 * Drops failed / tiny downloads (do not keep broken hotlinks in DB).
 * Inputs: scraped URL list. Outputs: durable URL list only.
 */
export async function ensureDurableVenueGalleryUrls(
  urls: string[],
): Promise<string[]> {
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    24,
  );
  if (list.length === 0) return [];

  const CONCURRENCY = 4;
  const out: string[] = [];

  const one = async (url: string): Promise<string | null> => {
    // Already our storage — keep (re-scrape replace will refresh the full set).
    if (isDurableCampaignImageUrl(url) && !/venue-photo-proxy/i.test(url)) {
      // Drop known-tiny local re-hosts if we can stat them (blurry covers).
      if (url.startsWith("/uploads/")) {
        try {
          const abs = path.join(process.cwd(), url.replace(/^\//, ""));
          const st = fs.statSync(abs);
          if (st.size > 0 && st.size < VENUE_GALLERY_MIN_BYTES) {
            console.warn(
              "ensureDurableVenueGalleryUrls drop tiny upload:",
              url,
              st.size,
            );
            return null;
          }
        } catch {
          /* missing file — drop so scrape can replace */
          return null;
        }
      }
      return normalizeDurableCampaignImageUrl(url);
    }
    const fetchUrl = preferLargerPublicImageUrl(unwrapVenuePhotoProxyUrl(url));
    const resyHeaders = /image\.resy\.com|images\.resy\.com/i.test(fetchUrl)
      ? {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          Referer: "https://resy.com/",
          Origin: "https://resy.com",
        }
      : undefined;
    try {
      return await ensureDurableImageUrl(fetchUrl, "venue-gallery", {
        headers: resyHeaders,
        maxBytes: VENUE_GALLERY_MAX_BYTES,
        minBytes: VENUE_GALLERY_MIN_BYTES,
      });
    } catch (err) {
      console.warn("ensureDurableVenueGalleryUrls drop:", fetchUrl, err);
      return null;
    }
  };

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const done = await Promise.all(batch.map(one));
    for (const u of done) {
      if (u) out.push(u);
    }
  }
  return [...new Set(out)];
}
