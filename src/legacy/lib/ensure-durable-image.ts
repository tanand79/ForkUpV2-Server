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

import fs from "fs";
import path from "path";
import { isS3Enabled, isS3Ref, uploadImageToS3 } from "./s3";

const MAX_BYTES = 8 * 1024 * 1024;
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
  const filename = `${prefix.slice(0, -1) || "img"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/${prefix}/${filename}`;
}

/**
 * Re-host a remote image when needed; pass through durable values unchanged.
 * Inputs: imageUrl, optional storage prefix. Outputs: durable storage URL.
 */
export async function ensureDurableImageUrl(
  imageUrl: string,
  prefix = "covers",
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

  if (isS3Enabled()) {
    try {
      return await uploadImageToS3(buffer, mime, prefix);
    } catch (err) {
      console.warn("S3 re-host failed; saving image to local disk instead:", err);
    }
  }

  return saveImageToDisk(buffer, mime, prefix);
}
