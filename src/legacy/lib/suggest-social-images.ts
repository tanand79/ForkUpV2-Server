/**
 * Suggest campaign gallery images from public social / website URLs.
 *
 * Purpose: During campaign create, collect up to 6 preview image URLs from
 * Open Graph / Twitter meta tags on the org website, Facebook page, and
 * Instagram profile (public HTML only — no Meta Graph API).
 *
 * Inputs: optional facebookUrl, instagramHandle, websiteUrl, limit (default 6)
 * Outputs: deduped list of { url, source, sourceUrl }
 */

export type SuggestedImageSource =
  | "website"
  | "facebook"
  | "instagram"
  | "social_suggest";

export interface SuggestedImage {
  url: string;
  source: SuggestedImageSource;
  sourceUrl: string | null;
}

const DEFAULT_LIMIT = 6;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize Instagram handle or URL → profile page URL. */
export function normalizeInstagramUrl(handleOrUrl: string): string | null {
  const raw = handleOrUrl.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ""))) return null;
      return `https://www.instagram.com${u.pathname.replace(/\/+$/, "")}/`;
    } catch {
      return null;
    }
  }
  const handle = raw.replace(/^@/, "").replace(/\/+$/, "").split(/[/?#]/)[0];
  if (!handle || !/^[A-Za-z0-9._]+$/.test(handle)) return null;
  return `https://www.instagram.com/${handle}/`;
}

/** Normalize Facebook page URL. */
export function normalizeFacebookUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    let withProto = raw;
    if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "facebook.com" && host !== "fb.com" && host !== "m.facebook.com") {
      return null;
    }
    return `https://www.facebook.com${u.pathname.replace(/\/+$/, "") || ""}`;
  } catch {
    return null;
  }
}

/** Normalize website URL. */
export function normalizeWebsiteUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    let withProto = raw;
    if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function absUrl(base: string, maybeRelative: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Extract candidate image URLs from HTML (og/twitter meta + a few same-host imgs).
 */
export function extractImageUrlsFromHtml(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const decoded = decodeHtmlEntities(raw.trim());
    if (!decoded || decoded.startsWith("data:")) return;
    const abs = absUrl(pageUrl, decoded);
    if (!abs || !/^https?:\/\//i.test(abs)) return;
    if (!found.includes(abs)) found.push(abs);
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
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      push(m[1]);
    }
  }

  // A few same-host <img> tags as fallback (skip tiny tracking pixels by URL heuristics).
  try {
    const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
    const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(html)) !== null && found.length < 12) {
      const abs = absUrl(pageUrl, m[1]!);
      if (!abs) continue;
      try {
        const host = new URL(abs).hostname.replace(/^www\./, "");
        if (host !== pageHost) continue;
        if (/\.(svg)(\?|$)/i.test(abs)) continue;
        if (/pixel|spacer|tracking|1x1|favicon/i.test(abs)) continue;
        push(abs);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  return found;
}

async function fetchHtml(url: string): Promise<string | null> {
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
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (ctype && !/html|text|xml/i.test(ctype) && !ctype.includes("octet-stream")) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) {
      return buf.subarray(0, MAX_HTML_BYTES).toString("utf8");
    }
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Confirm a candidate URL looks like a real image (skip HTML 404 pages). */
async function isReachableImage(url: string): Promise<boolean> {
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
    if (!(res.ok || res.status === 206)) return false;
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype.includes("text/html")) return false;
    if (ctype.startsWith("image/")) return true;
    // Some CDNs omit content-type on range requests — accept common image extensions.
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function collectFromPage(
  pageUrl: string,
  source: SuggestedImageSource,
  out: SuggestedImage[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  const html = await fetchHtml(pageUrl);
  if (!html) return;
  for (const imageUrl of extractImageUrlsFromHtml(html, pageUrl)) {
    if (out.length >= limit) break;
    if (out.some((i) => i.url === imageUrl)) continue;
    const ok = await isReachableImage(imageUrl);
    if (!ok) continue;
    out.push({ url: imageUrl, source, sourceUrl: pageUrl });
  }
}

/** Try both www and apex host when scraping a website. */
function websiteUrlVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const variants = [u.toString()];
    if (host.startsWith("www.")) {
      u.hostname = host.slice(4);
      variants.push(u.toString());
    } else {
      u.hostname = `www.${host}`;
      variants.push(u.toString());
    }
    return [...new Set(variants)];
  } catch {
    return [url];
  }
}

/**
 * Collect up to `limit` public preview images from the provided social/website URLs.
 */
export async function suggestSocialImages(input: {
  facebookUrl?: string;
  instagramHandle?: string;
  websiteUrl?: string;
  limit?: number;
}): Promise<SuggestedImage[]> {
  const limit = Math.min(
    DEFAULT_LIMIT,
    Math.max(1, Number.isFinite(input.limit) ? Number(input.limit) : DEFAULT_LIMIT),
  );
  const out: SuggestedImage[] = [];

  const website = normalizeWebsiteUrl(trimStr(input.websiteUrl));
  const facebook = normalizeFacebookUrl(trimStr(input.facebookUrl));
  const instagram = normalizeInstagramUrl(trimStr(input.instagramHandle));

  // Prefer website first (usually richest OG tags), then Facebook, then Instagram.
  if (website) {
    for (const variant of websiteUrlVariants(website)) {
      if (out.length >= limit) break;
      await collectFromPage(variant, "website", out, limit);
    }
  }
  if (facebook) await collectFromPage(facebook, "facebook", out, limit);
  if (instagram) await collectFromPage(instagram, "instagram", out, limit);

  return out.slice(0, limit);
}
