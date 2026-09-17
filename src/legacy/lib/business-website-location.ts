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
 */
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_200_000;
const MAX_PAGE_TEXT = 6_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** Common public paths that often list address / hours. */
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
  sourceUrl: string | null;
  websiteFound: boolean;
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
 * Outputs: best address/city/state found + text snippet for AI.
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
    sourceUrl: null,
    websiteFound: false,
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

  const uniqueUrls = [...new Set(urls)].slice(0, 12);

  let best: {
    score: number;
    parsed: ParsedAddress | null;
    pageText: string;
    sourceUrl: string;
  } | null = null;
  let anyOk = Boolean(seedHtml);

  for (const url of uniqueUrls) {
    const html = url === website ? seedHtml : await fetchHtml(url);
    if (!html) continue;
    anyOk = true;
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
    if (parsed && score >= 50) break;
  }

  if (!best) {
    return { ...empty, websiteFound: anyOk };
  }

  return {
    address: best.parsed?.address ?? "",
    city: best.parsed?.city ?? "",
    state: best.parsed?.state ?? "",
    zip: best.parsed?.zip ?? "",
    pageText: best.pageText,
    sourceUrl: best.sourceUrl,
    websiteFound: anyOk,
  };
}

/** True when a string is an AI placeholder, not a real place. */
export function isEmptyLocationValue(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s) return true;
  return /not provided|n\/?a|unknown|none|tbd|null|undefined/i.test(s);
}
