/**
 * Scrape multiple public pages on a business website for venue gallery photos.
 * Used by restaurant / local join so the profile carousel is not stuck on one OG image.
 *
 * Inputs: business website URL (+ optional booking page already found).
 * Outputs: ranked absolute image URLs (photos first; logos demoted).
 */
import { extractBookingPlatformLink } from "./booking-platform-links";
import {
  extractImageUrlsFromHtml,
  looksLikeDecorativeAssetUrl,
  looksLikeLogoUrl,
  photoCoverRank,
} from "./suggest-social-images";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_200_000;
const DEFAULT_LIMIT = 14;
const MAX_PAGES = 10;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/**
 * Resy consumer web API key (public — embedded in resy.com SPA).
 * Used only to read venue gallery photos; never for booking.
 */
const RESY_PUBLIC_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

/** Paths that often hold real venue / food photography. */
const PHOTO_PATHS = [
  "/",
  "/about",
  "/about-us",
  "/about-us/",
  "/gallery",
  "/gallery/",
  "/photos",
  "/photos/",
  "/our-story",
  "/menu",
  "/menus",
  "/menus/",
  "/food",
  "/dining",
  "/restaurant",
  "/private-dining",
  "/events",
  "/location",
  "/locations",
  "/visit",
  "/media",
];

function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function originOf(website: string): string | null {
  try {
    const u = new URL(normalizeWebsiteUrl(website));
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Prefer www host for restaurant sites (apex often hangs or redirects slowly). */
function preferWwwOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    if (!/^www\./i.test(u.hostname)) {
      u.hostname = `www.${u.hostname}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return origin;
  }
}

function apexOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    u.hostname = u.hostname.replace(/^www\./i, "");
    return `${u.protocol}//${u.host}`;
  } catch {
    return origin;
  }
}

/** Homepage HTML: try www first, then apex — never wait on a dead apex alone. */
async function fetchHomepageHtml(website: string): Promise<{
  html: string | null;
  origin: string;
  pageUrl: string;
}> {
  const rawOrigin = originOf(website);
  if (!rawOrigin) return { html: null, origin: "", pageUrl: website };
  const www = preferWwwOrigin(rawOrigin);
  const apex = apexOrigin(rawOrigin);
  const candidates =
    www.toLowerCase() === apex.toLowerCase()
      ? [www]
      : [www, apex];
  for (const origin of candidates) {
    const pageUrl = `${origin}/`;
    const html = await fetchHtml(pageUrl);
    if (html) return { html, origin, pageUrl };
  }
  return { html: null, origin: www, pageUrl: `${www}/` };
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
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const slice = buf.length > MAX_HTML_BYTES ? buf.subarray(0, MAX_HTML_BYTES) : buf;
    return slice.toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

function absUrl(base: string, maybeRelative: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

/** Extra lazy-load / CDN attributes many restaurant builders use. */
function extractLazyImageUrls(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const decoded = decodeHtmlEntities(raw.trim().split(/\s+/)[0] || "");
    if (!decoded || decoded.startsWith("data:")) return;
    const abs = absUrl(pageUrl, decoded);
    if (!abs || !/^https?:\/\//i.test(abs)) return;
    const hasExt = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs);
    const resyPath = /image\.resy\.com\/.+(?:\/jpg|\/jpeg|\/png|\/webp)(?:\/|$)/i.test(abs);
    if (!hasExt && !resyPath) return;
    if (/pixel|spacer|tracking|1x1|favicon|chevron/i.test(abs)) return;
    if (looksLikeDecorativeAssetUrl(abs)) return;
    if (!found.includes(abs)) found.push(abs);
  };

  const attrs = [
    /data-src=["']([^"']+)["']/gi,
    /data-lazy-src=["']([^"']+)["']/gi,
    /data-original=["']([^"']+)["']/gi,
    /data-image=["']([^"']+)["']/gi,
    /data-bg=["']([^"']+)["']/gi,
    /data-background(?:-image)?=["']([^"']+)["']/gi,
    /background-image:\s*url\((['"]?)([^)'"]+)\1\)/gi,
  ];
  for (const re of attrs) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      push(m[m.length - 1]);
    }
  }
  return found;
}

/** Same-site links that look like photo / gallery / about hubs. */
function discoverPhotoPageLinks(origin: string, html: string): string[] {
  const out: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    let abs = "";
    try {
      abs = new URL(href, origin).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith(origin)) continue;
    if (
      /gallery|photos?|about|our-story|menu|food|dining|media|portfolio|images?/i.test(
        abs,
      )
    ) {
      out.push(abs);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

/** Collapse CDN resize variants of the same asset. */
function imageDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    // Resy: .../<hash>/jpg/640x360 and .../<hash>/jpg/16:9/1600 are one photo.
    if (/image\.resy\.com$/i.test(u.hostname)) {
      path = path.replace(
        /\/(jpe?g|png|webp)(?:\/(?:\d+x\d+|1:1|4:3|16:9)(?:\/\d+)?)?$/i,
        "/$1",
      );
    }
    // Strip common size suffixes in the path when present.
    return path.replace(/[-_]\d{2,4}x\d{2,4}(?=\.[a-z]+$)/i, "");
  } catch {
    return url.split("?")[0].toLowerCase();
  }
}

/** Prefer a larger Resy crop when we only have the 640x360 list URL. */
/** Prefer the full Resy original — avoid 16:9 CDN crops that clip signs/heads. */
function preferResyImageUrl(url: string): string {
  if (!/image\.resy\.com/i.test(url)) return url;
  return url.replace(/\/(?:\d+x\d+|1:1\/\d+|4:3\/\d+|16:9\/\d+)$/i, "");
}

/**
 * Parse a Resy venue page URL → { location, urlSlug }.
 * Supports both:
 *   https://resy.com/cities/kennett-square-pa/venues/sovana-bistro
 *   https://resy.com/cities/knnt/sovana-bistro  (short city code, no /venues/)
 */
function parseResyVenueUrl(raw: string): { location: string; urlSlug: string } | null {
  try {
    const u = new URL(raw.trim());
    if (!/resy\.com$/i.test(u.hostname.replace(/^www\./, ""))) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const citiesIdx = parts.findIndex((p) => p.toLowerCase() === "cities");
    if (citiesIdx < 0) return null;
    const after = parts.slice(citiesIdx + 1);
    // cities/{location}/venues/{slug}
    if (after.length >= 3 && after[1]!.toLowerCase() === "venues") {
      const location = after[0];
      const urlSlug = after[2];
      if (location && urlSlug) return { location, urlSlug };
    }
    // cities/{location}/{slug}
    if (after.length >= 2 && after[1]!.toLowerCase() !== "venues") {
      const location = after[0];
      const urlSlug = after[1];
      if (location && urlSlug) return { location, urlSlug };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch venue gallery photos from Resy's public venue API.
 * Resy.com pages are an empty Angular shell — HTML scrape never sees the carousel.
 */
async function fetchResyVenueImages(reservationUrl: string): Promise<string[]> {
  const parsed = parseResyVenueUrl(reservationUrl);
  if (!parsed) return [];
  const apiUrl = `https://api.resy.com/3/venue?url_slug=${encodeURIComponent(parsed.urlSlug)}&location=${encodeURIComponent(parsed.location)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json, text/plain, */*",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
        Authorization: `ResyAPI api_key="${RESY_PUBLIC_API_KEY}"`,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      images?: unknown;
      responsive_images?: { originals?: Record<string, { url?: string }> };
    };
    const out: string[] = [];
    const originals = data.responsive_images?.originals;
    if (originals && typeof originals === "object") {
      for (const entry of Object.values(originals)) {
        const url = typeof entry?.url === "string" ? entry.url.trim() : "";
        if (url) out.push(preferResyImageUrl(url));
      }
    }
    if (out.length === 0 && Array.isArray(data.images)) {
      for (const img of data.images) {
        if (typeof img === "string" && img.trim()) {
          out.push(preferResyImageUrl(img.trim()));
        }
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Booking-platform galleries (Resy today). Append-only for other hosts later. */
async function fetchBookingPlatformVenueImages(
  reservationUrl: string | null | undefined,
): Promise<string[]> {
  const raw = (reservationUrl || "").trim();
  if (!raw) return [];
  if (/resy\.com/i.test(raw)) return fetchResyVenueImages(raw);
  return [];
}

function preferHigherRes(a: string, b: string): string {
  const score = (url: string) => {
    const w = /[?&]w=(\d+)/i.exec(url);
    const h = /[?&]h=(\d+)/i.exec(url);
    return (w ? Number(w[1]) : 0) + (h ? Number(h[1]) : 0) + url.length;
  };
  return score(a) >= score(b) ? a : b;
}

/**
 * Collect venue gallery photos from the business site (and booking page when linked).
 * Works for any restaurant / local business URL — not Sovana-specific.
 */
function rankVenueImageUrls(urls: string[]): string[] {
  return [...urls]
    .filter((u) => !looksLikeDecorativeAssetUrl(u))
    .sort((a, b) => {
      const logoA = looksLikeLogoUrl(a) ? 1 : 0;
      const logoB = looksLikeLogoUrl(b) ? 1 : 0;
      if (logoA !== logoB) return logoA - logoB;
      const resyA = /image\.resy\.com/i.test(a) ? 0 : 1;
      const resyB = /image\.resy\.com/i.test(b) ? 0 : 1;
      if (resyA !== resyB) return resyA - resyB;
      const jpgA = /\.(jpe?g|webp)(\?|$)|\/jpe?g(?:\/|$)/i.test(a) ? 0 : 1;
      const jpgB = /\.(jpe?g|webp)(\?|$)|\/jpe?g(?:\/|$)/i.test(b) ? 0 : 1;
      if (jpgA !== jpgB) return jpgA - jpgB;
      return photoCoverRank(a) - photoCoverRank(b);
    });
}

function proxyResyUrls(urls: string[]): string[] {
  return urls.map((url) =>
    /image\.resy\.com/i.test(url)
      ? `/api/venue-photo-proxy?url=${encodeURIComponent(url)}`
      : url,
  );
}

export async function scrapeBusinessVenueImages(input: {
  websiteUrl: string;
  reservationUrl?: string | null;
  limit?: number;
}): Promise<string[]> {
  const limit = Math.min(20, Math.max(4, input.limit ?? DEFAULT_LIMIT));
  const website = normalizeWebsiteUrl(input.websiteUrl);
  if (!website) return [];

  const home = await fetchHomepageHtml(website);
  const origin = home.origin || preferWwwOrigin(originOf(website) || "");
  if (!origin) return [];

  const seedHtml = home.html;
  const seedPageUrl = home.pageUrl || `${origin}/`;

  const urls: string[] = [seedPageUrl];
  for (const path of PHOTO_PATHS) {
    if (path === "/") continue;
    urls.push(`${origin}${path}`);
    if (!path.endsWith("/")) urls.push(`${origin}${path}/`);
  }

  if (seedHtml) {
    urls.push(...discoverPhotoPageLinks(origin, seedHtml));
    const booking =
      input.reservationUrl?.trim() ||
      extractBookingPlatformLink(seedHtml)?.url ||
      null;
    if (booking) urls.push(booking);
  } else if (input.reservationUrl?.trim()) {
    urls.push(input.reservationUrl.trim());
  }

  const bookingUrl =
    input.reservationUrl?.trim() ||
    (seedHtml ? extractBookingPlatformLink(seedHtml)?.url : null) ||
    null;
  const bookingPhotos = await fetchBookingPlatformVenueImages(bookingUrl);

  const byKey = new Map<string, string>();

  const ingest = (img: string) => {
    if (!img || looksLikeDecorativeAssetUrl(img)) return;
    const key = imageDedupeKey(img);
    const prev = byKey.get(key);
    byKey.set(key, prev ? preferHigherRes(prev, img) : img);
  };

  // Booking galleries first (Resy carousel) — real venue photos.
  for (const img of bookingPhotos) ingest(img);

  // Fast path: enough booking photos → skip multi-page site crawl (global).
  if (bookingPhotos.length >= Math.min(limit, 6)) {
    const bookingOnly = rankVenueImageUrls([...byKey.values()]).filter((u) =>
      /image\.resy\.com/i.test(u),
    );
    return proxyResyUrls(bookingOnly.slice(0, limit));
  }

  // When Resy (or another booking gallery) already gave real photos, skip
  // mixing in site PNG ornaments that look like "photos" by pixel size.
  const hasBookingGallery = bookingPhotos.length >= 3;

  const uniquePages = [...new Set(urls)].slice(0, MAX_PAGES);
  const PAGE_CONCURRENCY = 4;

  const ingestPage = (pageUrl: string, html: string | null) => {
    if (!html) return;
    const fromExtract = extractImageUrlsFromHtml(html, pageUrl);
    const fromLazy = extractLazyImageUrls(html, pageUrl);
    for (const img of [...fromExtract, ...fromLazy]) {
      if (
        hasBookingGallery &&
        /\.png(\?|$)/i.test(img) &&
        !/image\.resy\.com/i.test(img)
      ) {
        continue;
      }
      ingest(img);
    }
  };

  // Seed page already fetched — ingest without a second round-trip.
  ingestPage(seedPageUrl, seedHtml);

  const remaining = uniquePages.filter(
    (u) => u !== seedPageUrl && u !== website && u !== `${origin}/`,
  );

  for (let i = 0; i < remaining.length; i += PAGE_CONCURRENCY) {
    if (byKey.size >= limit) break;
    const batch = remaining.slice(i, i + PAGE_CONCURRENCY);
    const htmls = await Promise.all(batch.map((pageUrl) => fetchHtml(pageUrl)));
    batch.forEach((pageUrl, idx) => ingestPage(pageUrl, htmls[idx] ?? null));
  }

  let ranked = rankVenueImageUrls([...byKey.values()]);

  // Prefer the booking carousel when it has a full set.
  const bookingOnly = ranked.filter((u) => /image\.resy\.com/i.test(u));
  if (bookingOnly.length >= 4) {
    ranked = [
      ...bookingOnly,
      ...ranked.filter(
        (u) => !/image\.resy\.com/i.test(u) && /\.(jpe?g|webp)(\?|$)/i.test(u),
      ),
    ];
  }

  // Same-origin proxy so the browser gallery can render Resy CDN photos.
  return proxyResyUrls(ranked.slice(0, limit));
}
