/**
 * Pass D1 — scrape public business website HTML for location hints.
 *
 * Purpose: Prefer real page text (Hours & Location / Contact) over AI-only guesses
 * when drafting restaurant / local business profiles.
 *
 * Inputs: website URL string.
 * Outputs: address/city/state/zip when found, pageText snippet for AI, sourceUrl.
 *
 * Changelog (D1): Added — fetch given URL + common location paths; US address + JSON-LD parse.
 * Changelog: Also collect a booking-platform link (Resy, OpenTable, Tock, and other
 * hosts the site itself links to) so the public card can send guests to reserve.
 */
import { extractBookingPlatformLink } from "./booking-platform-links";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_200_000;
const MAX_PAGE_TEXT = 6_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** Common public paths that often list address / hours / about. */
const LOCATION_PATHS = [
  "/location",
  "/locations",
  "/contact",
  "/contact-us",
  "/hours",
  "/hours-location",
  "/about",
  "/about-us",
  "/find-us",
  "/visit",
];

export type BusinessLocationHints = {
  address: string;
  city: string;
  state: string;
  zip: string;
  /** Truncated plain text from the best page for AI context. */
  pageText: string;
  /** Meta / about-page story for the venue profile. */
  aboutHint: string;
  /** Hours section text when a hours/location page was found. */
  hoursText: string;
  sourceUrl: string | null;
  websiteFound: boolean;
  /** Venue page on Resy / OpenTable / Tock / other linked booking host. */
  reservationUrl: string | null;
  bookingPlatform: string | null;
  bookingLabel: string | null;
};

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

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * Fetch HTML for a public URL (browser UA, size-capped).
 * Inputs: absolute URL. Outputs: HTML string or null.
 */
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

/** Strip tags → readable text for address regex / AI snippet. */
function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const text = decodeHtmlEntities(
    withoutScripts
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/** Pull meta / Open Graph description from HTML. */
function extractMetaDescription(html: string): string {
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const value = m?.[1] ? decodeHtmlEntities(m[1]).trim() : "";
    if (value.length >= 40) return value.slice(0, 600);
  }
  return "";
}

/** Prefer story paragraphs from an About page (skip nav chrome). */
function extractAboutParagraphs(text: string): string {
  const cleaned = text
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  const start = cleaned.search(
    /\b(owners?\s*-|chef\s+\w+|about us|our story|for over \d+|welcome to)\b/i,
  );
  if (start < 0) return "";
  const slice = cleaned.slice(start, start + 2200);
  const chunks = slice
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 50)
    .filter(
      (p) =>
        !/skip to main|toggle navigation|order online|gift cards|reservations|follow us on|recaptcha|close this site|just minutes from|located on the corner|general manager|sommelier/i.test(
          p,
        ),
    );
  if (chunks.length === 0) {
    // Fallback: sentence split when the page has few line breaks.
    const sentences = slice
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 60)
      .filter(
        (s) =>
          !/skip to main|toggle navigation|order online|gift cards|recaptcha|just minutes from|general manager/i.test(
            s,
          ),
      );
    return sentences.slice(0, 4).join("\n\n").slice(0, 2000);
  }
  return chunks.slice(0, 4).join("\n\n").slice(0, 2000);
}

function aboutQualityScore(text: string): number {
  const t = text.trim();
  if (t.length < 40) return 0;
  let score = Math.min(40, Math.floor(t.length / 8));
  if (/\b(chef|owner|family|restaurant|bistro|cuisine|community|story)\b/i.test(t)) {
    score += 25;
  }
  if (/\b(about us|owners?|chef)\b/i.test(t)) score += 15;
  if (/recaptcha|close this site|just minutes from|located on the corner/i.test(t)) {
    score -= 40;
  }
  return score;
}

/** Isolate an Hours block from page text when present. */
function extractHoursBlock(text: string): string {
  const m = text.match(
    /(?:^|\n)\s*hours?\b(?!\s*&\s*location\b)[\s\S]{0,1800}?(?=\n\s*(?:holiday hours|contact|follow|reservations|menu|about)\b|$)/i,
  );
  if (m?.[0] && /\b(monday|tuesday|closed|lunch|dinner)\b/i.test(m[0])) {
    return m[0].trim().slice(0, 1800);
  }
  const dayHeavy = text.match(
    /(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)[\s\S]{0,1200}?(?:dinner|lunch|closed|am|pm)/i,
  );
  if (dayHeavy?.[0]) return dayHeavy[0].trim().slice(0, 1800);
  return "";
}

function scorePageForHours(text: string): number {
  let score = 0;
  if (/\bhours?\b/i.test(text)) score += 10;
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)) {
    score += 30;
  }
  if (/\b(closed|lunch|dinner|brunch)\b/i.test(text)) score += 25;
  if (/\d\s*[-–]\s*\d/.test(text) || /\d\s*(am|pm)\b/i.test(text)) score += 15;
  // Nav-only "Hours & Location" titles without real schedule.
  if (score < 40 && /hours\s*&\s*location/i.test(text) && !/\bclosed\b/i.test(text)) {
    return 0;
  }
  return score;
}

type ParsedAddress = { address: string; city: string; state: string; zip: string };

/**
 * Best-effort US street address from plain text.
 * Inputs: page text. Outputs: street/city/state/zip or null.
 */
function extractUsAddress(text: string): ParsedAddress | null {
  if (!text) return null;
  const re =
    /(\d{1,6}\s+[A-Za-z0-9.'\- ]{2,60}?\b(?:Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy)\.?)\s*[,.\n]+\s*([A-Za-z][A-Za-z.'\- ]{1,40}?)\s*,\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i;
  const m = re.exec(text);
  if (!m) return null;
  return {
    address: m[1].replace(/\s+/g, " ").trim(),
    city: m[2].replace(/\s+/g, " ").trim(),
    state: m[3].toUpperCase(),
    zip: m[4],
  };
}

/** Parse schema.org PostalAddress from JSON-LD blocks. */
function extractJsonLdAddress(html: string): ParsedAddress | null {
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return null;
  for (const block of blocks) {
    const inner = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    try {
      const data = JSON.parse(inner) as unknown;
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const found = walkJsonLdForAddress(node);
        if (found) return found;
      }
    } catch {
      /* ignore bad JSON-LD */
    }
  }
  return null;
}

function walkJsonLdForAddress(node: unknown, depth = 0): ParsedAddress | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  const addr = obj.address;
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    const street = typeof a.streetAddress === "string" ? a.streetAddress.trim() : "";
    const city = typeof a.addressLocality === "string" ? a.addressLocality.trim() : "";
    const state = typeof a.addressRegion === "string" ? a.addressRegion.trim() : "";
    const zip = typeof a.postalCode === "string" ? a.postalCode.trim() : "";
    if (city && state) {
      return {
        address: street,
        city,
        state: state.length === 2 ? state.toUpperCase() : state,
        zip,
      };
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const nested = walkJsonLdForAddress(item, depth + 1);
        if (nested) return nested;
      }
    } else if (v && typeof v === "object") {
      const nested = walkJsonLdForAddress(v, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Same-site hrefs that look like location/contact/hours pages. */
function discoverLocationLinks(origin: string, html: string): string[] {
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
    if (/location|contact|hours|find-?us|visit|about|address/i.test(abs)) {
      out.push(abs);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function scorePageForLocation(text: string, parsed: ParsedAddress | null): number {
  let score = 0;
  if (parsed) score += 50;
  if (/hours\s*&\s*location|location|address|kennett|directions/i.test(text)) score += 10;
  if (/\d{5}/.test(text)) score += 5;
  return score;
}

/**
 * Scrape a business website for location hints.
 * Inputs: any public page URL for the business (home, menus, etc.).
 * Outputs: best address/city/state found + about/hours text for the venue profile.
 */
export async function scrapeBusinessLocationHints(
  websiteInput: string,
): Promise<BusinessLocationHints> {
  const empty: BusinessLocationHints = {
    address: "",
    city: "",
    state: "",
    zip: "",
    pageText: "",
    aboutHint: "",
    hoursText: "",
    sourceUrl: null,
    websiteFound: false,
    reservationUrl: null,
    bookingPlatform: null,
    bookingLabel: null,
  };

  const website = normalizeWebsiteUrl(websiteInput);
  if (!website) return empty;

  const origin = originOf(website);
  if (!origin) return empty;

  const seedHtml = await fetchHtml(website);
  const urls: string[] = [website];
  if (seedHtml) {
    urls.push(...discoverLocationLinks(origin, seedHtml));
  }
  for (const path of LOCATION_PATHS) {
    urls.push(`${origin}${path}`);
    urls.push(`${origin}${path}/`);
  }

  const uniqueUrls = [...new Set(urls)].slice(0, 14);

  let best: {
    score: number;
    parsed: ParsedAddress | null;
    pageText: string;
    sourceUrl: string;
  } | null = null;
  let bestHours = { score: 0, text: "" };
  let bestAbout = { score: 0, text: "" };
  let anyOk = Boolean(seedHtml);
  let booking = seedHtml ? extractBookingPlatformLink(seedHtml) : null;
  const bookingRank = (platform: string) => {
    const order = ["resy", "opentable", "tock", "sevenrooms", "thefork"];
    const idx = order.indexOf(platform);
    return idx === -1 ? 20 : idx;
  };

  if (seedHtml) {
    const meta = extractMetaDescription(seedHtml);
    const metaScore = aboutQualityScore(meta);
    if (metaScore > 0) bestAbout = { score: metaScore + 5, text: meta };
  }

  for (const url of uniqueUrls) {
    const html = url === website ? seedHtml : await fetchHtml(url);
    if (!html) continue;
    anyOk = true;
    const found = extractBookingPlatformLink(html);
    if (found && (!booking || bookingRank(found.platform) < bookingRank(booking.platform))) {
      booking = found;
    }
    const fromLd = extractJsonLdAddress(html);
    const text = htmlToText(html);
    const fromText = extractUsAddress(text);
    const parsed = fromLd ?? fromText;
    const score = scorePageForLocation(text, parsed);
    if (!best || score > best.score) {
      best = {
        score,
        parsed,
        pageText: text.slice(0, MAX_PAGE_TEXT),
        sourceUrl: url,
      };
    }

    const hoursScore = scorePageForHours(text);
    if (hoursScore > bestHours.score) {
      const block = extractHoursBlock(text);
      if (block) bestHours = { score: hoursScore, text: block };
    }

    const meta = extractMetaDescription(html);
    const aboutFromPage = extractAboutParagraphs(text);
    for (const candidate of [aboutFromPage, meta]) {
      const q = aboutQualityScore(candidate);
      if (q > bestAbout.score) bestAbout = { score: q, text: candidate };
    }

    // Keep scanning until we have both an address and a hours block when possible.
    if (parsed && score >= 50 && bestHours.score >= 40 && bestAbout.score >= 30) break;
  }

  if (!best) {
    return {
      ...empty,
      aboutHint: bestAbout.text,
      hoursText: bestHours.text,
      websiteFound: anyOk,
      reservationUrl: booking?.url ?? null,
      bookingPlatform: booking?.platform ?? null,
      bookingLabel: booking?.label ?? null,
    };
  }

  const mergedPageText = [
    best.pageText,
    bestHours.text && bestHours.text !== best.pageText ? bestHours.text : "",
    bestAbout.text && !best.pageText.includes(bestAbout.text.slice(0, 40))
      ? bestAbout.text
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_PAGE_TEXT);

  return {
    address: best.parsed?.address ?? "",
    city: best.parsed?.city ?? "",
    state: best.parsed?.state ?? "",
    zip: best.parsed?.zip ?? "",
    pageText: mergedPageText,
    aboutHint: bestAbout.text,
    hoursText: bestHours.text,
    sourceUrl: best.sourceUrl,
    websiteFound: anyOk,
    reservationUrl: booking?.url ?? null,
    bookingPlatform: booking?.platform ?? null,
    bookingLabel: booking?.label ?? null,
  };
}

/** True when a string is an AI placeholder, not a real place. */
export function isEmptyLocationValue(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s) return true;
  return /not provided|n\/?a|unknown|none|tbd|null|undefined/i.test(s);
}
