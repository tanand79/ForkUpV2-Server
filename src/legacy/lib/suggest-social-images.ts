/**
 * Suggest campaign gallery images from public social / website URLs.
 *
 * Purpose: During campaign create, collect up to 6 preview image URLs from
 * Open Graph / Twitter meta tags on the org website, Facebook page, and
 * Instagram profile (public HTML only — no Meta Graph API).
 *
 * Inputs: optional facebookUrl, instagramHandle, websiteUrl, linkedinUrl,
 *         youtubeUrl, limit (default 6)
 * Outputs: deduped list of { url, source, sourceUrl, caption? }
 *
 * Changelog: Prefer real photos over logo/icon/SVG URLs when ranking suggestions.
 * Collect extra same-host <img> candidates so OG brand marks do not fill the slot.
 * Social-first image scrape; fall back to website when social OG returns nothing.
 * Additive: extract/discover Facebook/Instagram/LinkedIn/YouTube hrefs from org website HTML.
 * Additive: after profile URLs are known, extract public post captions + images
 * (see extract-social-posts.ts); keep profile/website OG scrape as fallback.
 * Additive: strict channel order Instagram → Facebook → LinkedIn → YouTube → website.
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
  /** Optional public post caption when extracted from a social post. */
  caption?: string | null;
}

const DEFAULT_LIMIT = 6;
/** Max images returned from a single social/website suggest call (scratch path uses 10). */
const MAX_SUGGEST_LIMIT = 10;
/** Collect extra candidates so logo demotion still leaves photo options. */
const CANDIDATE_POOL = 30;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * True when the URL path/query looks like a logo, icon, avatar, or SVG mark —
 * poor campaign covers. Used to demote (not delete) candidates.
 *
 * Inputs: absolute image URL
 * Outputs: boolean
 */
export function looksLikeLogoUrl(url: string): boolean {
  const raw = (url || "").trim();
  if (!raw) return false;
  if (/\.svg(\?|$)/i.test(raw)) return true;
  // LinkedIn chrome / generic aero assets are not usable campaign photos.
  if (/static\.licdn\.com\/aero/i.test(raw)) return true;
  return /logo|icon|favicon|avatar|profile[_-]?pic|wordmark|seal|badge|sprite|emoji|brand[_-]?mark|webclip|apple[_-]?touch/i.test(
    raw,
  );
}

/**
 * Lower is better for featured campaign covers.
 * Prefer hero/photo/CDN content assets; demote brand marks and bare PNG og:images.
 *
 * Inputs: absolute image URL
 * Outputs: rank number (0 = best)
 */
export function photoCoverRank(url: string): number {
  const raw = (url || "").trim();
  if (!raw) return 999;
  if (looksLikeLogoUrl(raw)) return 100;
  if (/hero|photo|portrait|team|gallery|donate|people|event|bg[-_]|[_-]bg|shoelace/i.test(raw)) {
    return 0;
  }
  if (/\.avif(\?|$)/i.test(raw)) return 5;
  if (/\.(jpe?g|webp)(\?|$)/i.test(raw)) return 10;
  if (/\.png(\?|$)/i.test(raw)) return 25;
  return 15;
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

/**
 * Normalize LinkedIn company/profile URL.
 * Inputs: raw href or typed URL. Outputs: https://www.linkedin.com/... or null.
 */
export function normalizeLinkedInUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    let withProto = raw;
    if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "linkedin.com") return null;
    const path = u.pathname.replace(/\/+$/, "") || "";
    if (!path || path === "/") return null;
    return `https://www.linkedin.com${path}`;
  } catch {
    return null;
  }
}

/**
 * Normalize YouTube channel / @handle / watch URL to a stable https URL.
 * Inputs: raw href. Outputs: https://www.youtube.com/... or null (rejects # / empty).
 */
export function normalizeYouTubeUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw || raw === "#" || raw.startsWith("#")) return null;
  try {
    let withProto = raw;
    if (!/^https?:\/\//i.test(withProto)) {
      if (raw.startsWith("@")) withProto = `https://www.youtube.com/${raw}`;
      else if (/^youtube\.com|^youtu\.be/i.test(raw)) withProto = `https://${raw}`;
      else return null;
    }
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "youtube.com" && host !== "youtu.be" && host !== "m.youtube.com") {
      return null;
    }
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (!id) return null;
      return `https://www.youtube.com/watch?v=${id}`;
    }
    const path = u.pathname.replace(/\/+$/, "") || "";
    if (!path || path === "/") return null;
    return `https://www.youtube.com${path}${u.search || ""}`;
  } catch {
    return null;
  }
}

/** True when a Facebook URL is a share-widget / plugin — not an org presence link. */
function isFacebookUtilityLink(url: string): boolean {
  // Keep facebook.com/share/<id> — modern profile share links used on many org footers.
  // Skip classic sharer.php / dialog / plugin embeds only.
  return /facebook\.com\/(sharer\.php|sharer\/|dialog\/|plugins\/)/i.test(url);
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
 * Extract candidate image URLs from HTML (og/twitter meta + page img/srcset).
 * Includes common CDN hosts (Webflow etc.) — not only same-host paths.
 * Photos are ranked ahead of logo-like URLs.
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

  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const acceptHostedImage = (abs: string): boolean => {
    try {
      const host = new URL(abs).hostname.replace(/^www\./, "");
      if (host === pageHost) return true;
      // Allow CDN / media hosts used by nonprofit site builders (Webflow, etc.).
      if (/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs)) return true;
      return false;
    } catch {
      return false;
    }
  };

  // Page <img> tags (same-host or CDN photo assets). Skip SVG / trackers.
  try {
    const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    let imgAdded = 0;
    while ((m = imgRe.exec(html)) !== null && imgAdded < 24) {
      const abs = absUrl(pageUrl, m[1]!);
      if (!abs) continue;
      if (/\.(svg)(\?|$)/i.test(abs)) continue;
      if (/pixel|spacer|tracking|1x1|favicon|chevron|close[_-]?button/i.test(abs)) continue;
      if (!acceptHostedImage(abs)) continue;
      const before = found.length;
      push(abs);
      if (found.length > before) imgAdded += 1;
    }
  } catch {
    /* skip */
  }

  // Prefer largest usable candidate from srcset (often real photos on Webflow).
  try {
    const srcsetRe = /srcset=["']([^"']+)["']/gi;
    let sm: RegExpExecArray | null;
    let srcsetAdded = 0;
    while ((sm = srcsetRe.exec(html)) !== null && srcsetAdded < 16) {
      const entries = sm[1]!
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean) as string[];
      for (const cand of entries.reverse()) {
        const abs = absUrl(pageUrl, cand);
        if (!abs) continue;
        if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs)) continue;
        if (/pixel|spacer|tracking|1x1|favicon|logo|icon/i.test(abs)) continue;
        if (!acceptHostedImage(abs)) continue;
        const before = found.length;
        push(abs);
        if (found.length > before) {
          srcsetAdded += 1;
          break;
        }
      }
    }
  } catch {
    /* skip */
  }

  // Embedded Instagram / Facebook CDN URLs (post thumbnails inside scripts/JSON).
  try {
    const cdnRe =
      /https?:\\?\/\\?\/[^\s"'<>\\]+(?:cdninstagram\.com|fbcdn\.net|scontent[^\s"'<>\\]*\.fbcdn\.net)[^\s"'<>\\]*/gi;
    let cm: RegExpExecArray | null;
    let cdnAdded = 0;
    while ((cm = cdnRe.exec(html)) !== null && cdnAdded < 40) {
      const raw = (cm[0] || "").replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
      const cleaned = raw.split("?")[0] || raw;
      if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(cleaned) && !/\/[tp]\d+x\d+\//i.test(raw)) {
        // Many IG CDN URLs omit extension; still accept known CDN hosts.
        if (!/cdninstagram|fbcdn|scontent/i.test(raw)) continue;
      }
      if (/profile|avatar|logo|emoji|static/i.test(raw)) continue;
      const before = found.length;
      push(raw);
      if (found.length > before) cdnAdded += 1;
    }
  } catch {
    /* skip */
  }

  return found.sort((a, b) => photoCoverRank(a) - photoCoverRank(b));
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
    return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url);
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
 * Extract public Facebook / Instagram / LinkedIn / YouTube profile URLs from page HTML.
 * Purpose: Prefill Connect Social when the organizer did not type links.
 * Inputs: raw HTML string. Outputs: normalized social URLs (null when missing).
 */
export function extractSocialLinksFromHtml(html: string): {
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
} {
  let facebookUrl: string | null = null;
  let instagramUrl: string | null = null;
  let linkedinUrl: string | null = null;
  let youtubeUrl: string | null = null;

  const candidates: string[] = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    if (m[1]) candidates.push(decodeHtmlEntities(m[1].trim()));
  }
  // Catch bare social URLs that are not wrapped in href (JSON-LD / scripts).
  const bareRe =
    /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|m\.facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be)\/[^\s"'<>]+/gi;
  while ((m = bareRe.exec(html)) !== null) {
    if (m[0]) candidates.push(m[0].replace(/[),.;]+$/, ""));
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
      if (yt) youtubeUrl = yt;
    }
    if (facebookUrl && instagramUrl && linkedinUrl && youtubeUrl) break;
  }

  return { facebookUrl, instagramUrl, linkedinUrl, youtubeUrl };
}

/**
 * Fetch the org website and discover social profile links from public HTML.
 * Inputs: website URL. Outputs: facebook/instagram/linkedin/youtube URLs or nulls.
 */
export async function discoverSocialLinksFromWebsite(websiteUrl: string): Promise<{
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
}> {
  const empty = {
    facebookUrl: null as string | null,
    instagramUrl: null as string | null,
    linkedinUrl: null as string | null,
    youtubeUrl: null as string | null,
  };
  const normalized = normalizeWebsiteUrl(websiteUrl);
  if (!normalized) return empty;

  for (const variant of websiteUrlVariants(normalized)) {
    const html = await fetchHtml(variant);
    if (!html) continue;
    const found = extractSocialLinksFromHtml(html);
    if (found.facebookUrl || found.instagramUrl || found.linkedinUrl || found.youtubeUrl) {
      return found;
    }
  }
  return empty;
}

/**
 * Map a social platform name to the gallery source enum allowed by campaign_images.
 * Inputs: platform string from extract-social-posts. Outputs: SuggestedImageSource.
 */
function suggestedSourceForPlatform(platform: string): SuggestedImageSource {
  if (platform === "facebook") return "facebook";
  if (platform === "instagram") return "instagram";
  return "social_suggest";
}

/**
 * Channel priority for returned gallery order.
 * Instagram → Facebook → LinkedIn → YouTube → other social → website.
 * Inputs: SuggestedImage. Outputs: lower number = preferred.
 */
function suggestedChannelRank(img: SuggestedImage): number {
  if (img.source === "instagram") return 0;
  if (img.source === "facebook") return 10;
  if (img.source === "social_suggest") {
    const ref = `${img.sourceUrl || ""} ${img.url || ""}`;
    if (/linkedin\.com|licdn\.com/i.test(ref)) return 20;
    if (/youtube\.com|youtu\.be|ytimg\.com/i.test(ref)) return 30;
    return 35;
  }
  if (img.source === "website") return 40;
  return 50;
}

/**
 * Append reachable post images from one profile into `out` (stops at poolLimit).
 * Inputs: profile URL, max posts, out array, pool limit.
 * Outputs: void (mutates out).
 */
async function appendImagesFromProfilePosts(
  profileUrl: string | null,
  maxPosts: number,
  out: SuggestedImage[],
  poolLimit: number,
): Promise<void> {
  if (!profileUrl || out.length >= poolLimit) return;
  try {
    const { extractPostsFromProfileUrl } = await import("./extract-social-posts.js");
    const posts = await extractPostsFromProfileUrl(profileUrl, maxPosts);
    for (const post of posts) {
      if (out.length >= poolLimit) break;
      if (post.status !== "ok" && post.status !== "no_images") continue;
      for (const imageUrl of post.imageUrls) {
        if (out.length >= poolLimit) break;
        if (out.some((i) => i.url === imageUrl)) continue;
        const ok = await isReachableImage(imageUrl);
        if (!ok) continue;
        out.push({
          url: imageUrl,
          source: suggestedSourceForPlatform(post.platform),
          sourceUrl: post.postUrl || post.profileUrl,
          caption: post.caption,
        });
      }
    }
  } catch {
    /* keep going with remaining channels */
  }
}

/**
 * Collect up to `limit` public preview images from the provided social/website URLs.
 * Logos/icons are kept only as fallback after real photos.
 *
 * Priority (strict channel order):
 *  1) Instagram posts / profile
 *  2) Facebook posts / profile
 *  3) LinkedIn posts
 *  4) YouTube videos
 *  5) Website only when social yields nothing
 */
export async function suggestSocialImages(input: {
  facebookUrl?: string;
  instagramHandle?: string;
  websiteUrl?: string;
  /** Additive: LinkedIn company/profile URL for post extraction. */
  linkedinUrl?: string;
  /** Additive: YouTube channel URL for recent video thumbnails. */
  youtubeUrl?: string;
  limit?: number;
}): Promise<SuggestedImage[]> {
  const limit = Math.min(
    MAX_SUGGEST_LIMIT,
    Math.max(1, Number.isFinite(input.limit) ? Number(input.limit) : DEFAULT_LIMIT),
  );
  const poolLimit = Math.min(CANDIDATE_POOL, Math.max(limit * 3, limit));
  const out: SuggestedImage[] = [];

  const website = normalizeWebsiteUrl(trimStr(input.websiteUrl));
  const facebook = normalizeFacebookUrl(trimStr(input.facebookUrl));
  const instagram = normalizeInstagramUrl(trimStr(input.instagramHandle));
  const linkedin = normalizeLinkedInUrl(trimStr(input.linkedinUrl));
  const youtube = normalizeYouTubeUrl(trimStr(input.youtubeUrl));
  const hasSocial = Boolean(facebook || instagram || linkedin || youtube);

  // Post extraction in product order: IG → FB → LI → YT.
  if (hasSocial) {
    await appendImagesFromProfilePosts(instagram, 8, out, poolLimit);
    await appendImagesFromProfilePosts(facebook, 4, out, poolLimit);
    await appendImagesFromProfilePosts(linkedin, 4, out, poolLimit);
    await appendImagesFromProfilePosts(youtube, 4, out, poolLimit);
  }

  // Profile-page OG scrape fills remaining slots (IG before FB).
  if (hasSocial && out.length < poolLimit) {
    if (instagram) await collectFromPage(instagram, "instagram", out, poolLimit);
    if (facebook) await collectFromPage(facebook, "facebook", out, poolLimit);
  }

  // Website fallback: no social URLs, or social pages blocked/empty images.
  if (website && out.length === 0) {
    for (const variant of websiteUrlVariants(website)) {
      if (out.length >= poolLimit) break;
      await collectFromPage(variant, "website", out, poolLimit);
    }
  }

  out.sort((a, b) => {
    const channel = suggestedChannelRank(a) - suggestedChannelRank(b);
    if (channel !== 0) return channel;
    return photoCoverRank(a.url) - photoCoverRank(b.url);
  });
  return out.slice(0, limit);
}
