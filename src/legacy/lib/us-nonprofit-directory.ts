/**
 * US nonprofit directory lookup via ProPublica (IRS) + Every.org enrichment.
 *
 * Purpose: Power GoFundMe-style typeahead with national US nonprofit matches.
 * ProPublica provides name/EIN/location; Every.org (when available) adds
 * websiteUrl + logoUrl that IRS filings do not include.
 *
 * Data sources:
 * - https://projects.propublica.org/nonprofits/api/
 * - https://partners.every.org/v0.2/nonprofit/:ein
 */

import { guessNonprofitWebsite } from "./guess-nonprofit-website";

export type UsNonprofitSuggestion = {
  /** Always 0 — not a ForkUp DB row until the user claims/creates. */
  id: number;
  organizationName: string;
  slug: string;
  mission: string | null;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  causeCategory: string | null;
  ein: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  verificationStatus: string;
  claimStatus: string;
  profileStatus: string;
  verified: boolean;
  matchStrength: "strong" | "partial" | "weak";
  source: "irs_us";
  logoUrl: string | null;
};

/** Full enrich payload for the confirm-org form after a US directory pick. */
export type UsNonprofitEnrichment = {
  ein: string;
  organizationName: string | null;
  website: string | null;
  logoUrl: string | null;
  mission: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  providers: string[];
};

type ProPublicaOrg = {
  ein?: number;
  strein?: string;
  name?: string;
  sub_name?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  ntee_code?: string | null;
  score?: number;
};

type ProPublicaSearchResponse = {
  organizations?: ProPublicaOrg[];
  total_results?: number;
};

type ProPublicaOrgDetailResponse = {
  organization?: {
    name?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    ein?: number;
  };
};

type EveryOrgNonprofit = {
  name?: string;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  logoCloudinaryId?: string | null;
  description?: string | null;
  locationAddress?: string | null;
};

const PROPUBLICA_SEARCH =
  "https://projects.propublica.org/nonprofits/api/v2/search.json";
const PROPUBLICA_ORG =
  "https://projects.propublica.org/nonprofits/api/v2/organizations";
const EVERY_ORG_DETAIL = "https://partners.every.org/v0.2/nonprofit";

const FETCH_TIMEOUT_MS = 4500;
const ENRICH_TIMEOUT_MS = 3500;

/** Title-case IRS ALL-CAPS names for display (keeps short acronyms). */
function displayOrgName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (!/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    return trimmed
      .toLowerCase()
      .split(" ")
      .map((w) => {
        if (w.length <= 3 && /^[a-z]+$/.test(w)) return w.toUpperCase();
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ");
  }
  return trimmed;
}

function digitsOnlyEin(raw: string): string {
  return raw.replace(/\D/g, "").padStart(9, "0").slice(-9);
}

function formatEin(strein: string | undefined, ein: number | undefined): string | null {
  if (strein && /^\d{2}-\d{7}$/.test(strein)) return strein;
  if (ein == null || !Number.isFinite(ein)) return null;
  const digits = String(Math.trunc(ein)).padStart(9, "0");
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function formatEinFromDigits(digits: string): string {
  const d = digitsOnlyEin(digits);
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}

/** Prefer a larger Cloudinary crop for avatars (Every.org defaults to 24px). */
function bumpLogoSize(logoUrl: string | null | undefined): string | null {
  if (!logoUrl?.trim()) return null;
  return logoUrl
    .replace(/w_24,h_24/g, "w_128,h_128")
    .replace(/w_48,h_48/g, "w_128,h_128");
}

function normalizeWebsite(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function mapOrg(org: ProPublicaOrg): UsNonprofitSuggestion | null {
  const name = displayOrgName(org.name ?? "");
  if (!name) return null;
  const ein = formatEin(org.strein, org.ein);
  const zip =
    typeof org.zipcode === "string" && org.zipcode.trim()
      ? org.zipcode.trim().slice(0, 10)
      : null;
  const score = typeof org.score === "number" ? org.score : 0;
  const matchStrength: UsNonprofitSuggestion["matchStrength"] =
    score >= 90 ? "strong" : score >= 60 ? "partial" : "weak";

  return {
    id: 0,
    organizationName: name,
    /** Empty slug — claim flow must create/claim, not look up a ForkUp row. */
    slug: "",
    mission: null,
    website: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    causeCategory: org.ntee_code ? `NTEE ${org.ntee_code}` : null,
    ein,
    city: org.city?.trim() || null,
    state: org.state?.trim() || null,
    zip,
    verificationStatus: "unclaimed",
    claimStatus: "unclaimed",
    profileStatus: "irs_directory",
    verified: false,
    matchStrength,
    source: "irs_us",
    logoUrl: null,
  };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type EveryOrgLite = {
  website: string | null;
  logoUrl: string | null;
  mission: string | null;
  organizationName: string | null;
};

/** Every.org detail by EIN — returns website + logo when the charity has a profile. */
async function fetchEveryOrgByEin(einDigits: string): Promise<EveryOrgLite | null> {
  const body = await fetchJson<{ data?: { nonprofit?: EveryOrgNonprofit } }>(
    `${EVERY_ORG_DETAIL}/${einDigits}`,
    ENRICH_TIMEOUT_MS,
  );
  const np = body?.data?.nonprofit;
  if (!np) return null;
  return {
    website: normalizeWebsite(np.websiteUrl),
    logoUrl: bumpLogoSize(np.logoUrl),
    mission: np.description?.trim() || null,
    organizationName: np.name?.trim() || null,
  };
}

/** ProPublica org detail — fills ZIP (search results often omit it). */
async function fetchProPublicaDetail(einDigits: string): Promise<{
  organizationName: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} | null> {
  const body = await fetchJson<ProPublicaOrgDetailResponse>(
    `${PROPUBLICA_ORG}/${Number(einDigits)}.json`,
    ENRICH_TIMEOUT_MS,
  );
  const org = body?.organization;
  if (!org) return null;
  return {
    organizationName: org.name ? displayOrgName(org.name) : null,
    city: org.city?.trim() || null,
    state: org.state?.trim() || null,
    zip: org.zipcode?.trim()?.slice(0, 10) || null,
  };
}

export type EnrichUsNonprofitOptions = {
  ein: string;
  /** Used to AI-guess website when Every.org has none. */
  organizationName?: string;
  city?: string;
  state?: string;
};

/**
 * Enrich a US IRS pick with website/logo (Every.org) + ZIP (ProPublica detail).
 * When website is still missing, optionally AI-guess from organization name.
 * Safe when fields are missing — many small orgs simply have no public website/logo.
 */
export async function enrichUsNonprofitByEin(
  einRaw: string,
  options?: Omit<EnrichUsNonprofitOptions, "ein">,
): Promise<UsNonprofitEnrichment | null> {
  const digits = digitsOnlyEin(einRaw);
  if (!/^\d{9}$/.test(digits)) return null;

  const providers: string[] = [];
  const [pp, eo] = await Promise.all([
    fetchProPublicaDetail(digits),
    fetchEveryOrgByEin(digits),
  ]);
  if (pp) providers.push("propublica");
  if (eo) providers.push("every_org");

  if (!pp && !eo) {
    const orgName = options?.organizationName?.trim() || "";
    if (!orgName) return null;
    const guessed = await guessNonprofitWebsite({
      organizationName: orgName,
      ein: formatEinFromDigits(digits),
      city: options?.city || null,
      state: options?.state || null,
    });
    if (!guessed.website) return null;
    const providers: string[] = [];
    if (guessed.provider) providers.push(guessed.provider);
    return {
      ein: formatEinFromDigits(digits),
      organizationName: orgName,
      website: guessed.website,
      logoUrl: null,
      mission: null,
      city: options?.city || null,
      state: options?.state || null,
      zip: null,
      providers,
    };
  }

  let website = eo?.website || null;
  const orgName = options?.organizationName?.trim() || eo?.organizationName || pp?.organizationName || "";
  if (!website && orgName) {
    const guessed = await guessNonprofitWebsite({
      organizationName: orgName,
      ein: formatEinFromDigits(digits),
      city: options?.city || pp?.city || null,
      state: options?.state || pp?.state || null,
    });
    if (guessed.website) {
      website = guessed.website;
      if (guessed.provider) providers.push(guessed.provider);
    }
  }

  return {
    ein: formatEinFromDigits(digits),
    organizationName: eo?.organizationName || pp?.organizationName || null,
    website,
    logoUrl: eo?.logoUrl || null,
    mission: eo?.mission || null,
    city: pp?.city || null,
    state: pp?.state || null,
    zip: pp?.zip || null,
    providers,
  };
}

/** Attach Every.org logo/website onto suggestion rows (best-effort, parallel). */
async function attachEveryOrgEnrichment(
  candidates: UsNonprofitSuggestion[],
): Promise<UsNonprofitSuggestion[]> {
  return Promise.all(
    candidates.map(async (c) => {
      if (!c.ein) return c;
      const eo = await fetchEveryOrgByEin(digitsOnlyEin(c.ein));
      if (!eo) return c;
      return {
        ...c,
        website: eo.website || c.website,
        logoUrl: eo.logoUrl || c.logoUrl,
        mission: eo.mission || c.mission,
      };
    }),
  );
}

export type UsNonprofitSuggestParams = {
  q: string;
  /** Optional 2-letter US state filter (ProPublica state[id]). */
  state?: string;
  /** Max suggestions to return (capped server-side). */
  limit?: number;
};

/**
 * Search US nonprofits (IRS via ProPublica), then enrich logos/websites via Every.org.
 */
export async function suggestUsNonprofits(
  params: UsNonprofitSuggestParams,
): Promise<{ candidates: UsNonprofitSuggestion[]; totalResults: number; provider: string }> {
  const q = params.q.trim();
  if (q.length < 2) {
    return { candidates: [], totalResults: 0, provider: "propublica" };
  }

  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);
  const url = new URL(PROPUBLICA_SEARCH);
  url.searchParams.set("q", q);
  url.searchParams.set("page", "0");
  // Prefer public charities (501(c)(3)) — closest to GoFundMe-style charity search.
  url.searchParams.set("c_code[id]", "3");
  const state = params.state?.trim().toUpperCase();
  if (state && /^[A-Z]{2}$/.test(state)) {
    url.searchParams.set("state[id]", state);
  }

  const body = await fetchJson<ProPublicaSearchResponse>(url.toString(), FETCH_TIMEOUT_MS);
  if (!body) {
    return { candidates: [], totalResults: 0, provider: "propublica" };
  }

  const mapped = (body.organizations ?? [])
    .map(mapOrg)
    .filter((row): row is UsNonprofitSuggestion => row != null)
    .slice(0, limit);

  const enriched = await attachEveryOrgEnrichment(mapped);

  return {
    candidates: enriched,
    totalResults: typeof body.total_results === "number" ? body.total_results : enriched.length,
    provider: "propublica+every_org",
  };
}
