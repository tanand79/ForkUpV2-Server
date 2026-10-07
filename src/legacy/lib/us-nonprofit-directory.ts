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
 *
 * Additive: exact-org identity ranking on suggest; verified website + scrape
 * social/contact on enrich (AI only when confident).
 */

import { guessNonprofitWebsite } from "./guess-nonprofit-website";
import { guessNonprofitSocialLinks } from "./guess-nonprofit-social";
import {
  nonprofitWebResearchConfigured,
  researchNonprofitProfile,
} from "./nonprofit-web-research";
import { discoverSocialLinksFromWebsite } from "./suggest-social-images";
import {
  filterByOrgIdentityMatch,
  scoreOrgNameMatch,
  verifyWebsiteBelongsToOrg,
  type IdentityMatchTier,
} from "./verify-nonprofit-identity";

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
  /** Additive: exact-org identity vs the user query (not ProPublica score). */
  identityMatch?: IdentityMatchTier;
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
  /** Additive: verified social / contact scraped or AI-verified. */
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  youtubeUrl?: string | null;
  tiktokUrl?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** Additive: how confident website/contact are for this exact org. */
  confidence?: "high" | "medium" | "low";
  identityMatch?: IdentityMatchTier;
  verifiedWebsite?: boolean;
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
 * After a website is known, scrape About/contact/social. If still missing social
 * and there is no website, fall back to verified AI social guesses.
 */
async function attachVerifiedContactLayer(params: {
  organizationName: string;
  website: string | null;
  ein: string;
  city: string | null;
  state: string | null;
  mission: string | null;
  providers: string[];
}): Promise<{
  website: string | null;
  mission: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
  tiktokUrl: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  confidence: "high" | "medium" | "low";
  verifiedWebsite: boolean;
  providers: string[];
}> {
  const providers = [...params.providers];
  let website = params.website;
  let mission = params.mission;
  let facebookUrl: string | null = null;
  let instagramUrl: string | null = null;
  let linkedinUrl: string | null = null;
  let youtubeUrl: string | null = null;
  let tiktokUrl: string | null = null;
  let contactEmail: string | null = null;
  let contactPhone: string | null = null;
  let verifiedWebsite = false;
  let confidence: "high" | "medium" | "low" = "low";

  if (website) {
    const verified = await verifyWebsiteBelongsToOrg({
      organizationName: params.organizationName,
      website,
      city: params.city,
      state: params.state,
    });
    if (verified.ok && verified.website) {
      website = verified.website;
      verifiedWebsite = true;
      confidence = verified.confidence;
      providers.push("website_verify");
      if (!mission && verified.pageDescription) {
        mission = verified.pageDescription;
      }
    } else if (verified.reason === "unreachable") {
      // Keep provider URL when fetch times out; scrape may still succeed via www.
      providers.push("website_unverified_unreachable");
      confidence = "low";
    } else {
      // Do not return an identity-rejected lookalike website.
      website = null;
      verifiedWebsite = false;
    }
  }

  if (website) {
    const discovered = await discoverSocialLinksFromWebsite(website);
    facebookUrl = discovered.facebookUrl;
    instagramUrl = discovered.instagramUrl;
    linkedinUrl = discovered.linkedinUrl;
    youtubeUrl = discovered.youtubeUrl;
    tiktokUrl = discovered.tiktokUrl;
    contactPhone = discovered.phone;
    contactEmail = discovered.email;
    if (
      facebookUrl ||
      instagramUrl ||
      linkedinUrl ||
      youtubeUrl ||
      tiktokUrl ||
      contactPhone ||
      contactEmail
    ) {
      providers.push("website_scrape");
      if (confidence === "low") confidence = "medium";
    }
  }

  // No website (or site had no social): verified AI social only — never invent.
  if (!facebookUrl || !instagramUrl || !linkedinUrl || !youtubeUrl) {
    const guessedSocial = await guessNonprofitSocialLinks({
      organizationName: params.organizationName,
      ein: params.ein,
      city: params.city,
      state: params.state,
    });
    if (!facebookUrl && guessedSocial.facebookUrl) facebookUrl = guessedSocial.facebookUrl;
    if (!instagramUrl && guessedSocial.instagramUrl) {
      instagramUrl = guessedSocial.instagramUrl;
    }
    if (!linkedinUrl && guessedSocial.linkedinUrl) linkedinUrl = guessedSocial.linkedinUrl;
    if (!youtubeUrl && guessedSocial.youtubeUrl) youtubeUrl = guessedSocial.youtubeUrl;
    if (guessedSocial.provider) providers.push(`social_${guessedSocial.provider}`);
  }

  if (verifiedWebsite && confidence === "low") confidence = "medium";
  if (verifiedWebsite && (facebookUrl || contactEmail || contactPhone)) {
    confidence = confidence === "low" ? "medium" : confidence;
  }

  // Last resort: full Tavily+Bedrock research when still thin (no site / no social).
  const stillThin =
    !website && !facebookUrl && !instagramUrl;
  if (stillThin && nonprofitWebResearchConfigured() && params.organizationName.trim()) {
    try {
      const researched = await researchNonprofitProfile({
        organizationName: params.organizationName,
        ein: params.ein,
        city: params.city,
        state: params.state,
        signal: AbortSignal.timeout(90_000),
      });
      if (researched.status === "found" && researched.provider) {
        providers.push(researched.provider);
        if (!website && researched.website) {
          const verified = await verifyWebsiteBelongsToOrg({
            organizationName: researched.name || params.organizationName,
            website: researched.website,
            city: params.city,
            state: params.state,
          });
          if (verified.ok && verified.website) {
            website = verified.website;
            verifiedWebsite = true;
            confidence = verified.confidence;
          } else if (verified.reason === "unreachable" && researched.website) {
            website = researched.website;
            confidence = "low";
          }
        }
        if (!mission && researched.mission) mission = researched.mission;
        else if (!mission && researched.about) mission = researched.about;
        if (!facebookUrl && researched.facebookUrl) facebookUrl = researched.facebookUrl;
        if (!instagramUrl && researched.instagramUrl) {
          instagramUrl = researched.instagramUrl;
        }
        if (!linkedinUrl && researched.linkedinUrl) linkedinUrl = researched.linkedinUrl;
        if (!youtubeUrl && researched.youtubeUrl) youtubeUrl = researched.youtubeUrl;
        if (!contactEmail && researched.contactEmail) {
          contactEmail = researched.contactEmail;
        }
        if (!contactPhone && researched.contactPhone) {
          contactPhone = researched.contactPhone;
        }
        if (website && confidence === "low") confidence = "medium";
      }
    } catch {
      /* keep thin enrich — research is best-effort */
    }
  }

  return {
    website,
    mission,
    facebookUrl,
    instagramUrl,
    linkedinUrl,
    youtubeUrl,
    tiktokUrl,
    contactEmail,
    contactPhone,
    confidence,
    verifiedWebsite,
    providers,
  };
}

/**
 * Enrich a US IRS pick with website/logo (Every.org) + ZIP (ProPublica detail).
 * When website is still missing, optionally AI-guess from organization name,
 * then verify the page belongs to this exact org and scrape contact/social.
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

  const orgName =
    options?.organizationName?.trim() ||
    eo?.organizationName ||
    pp?.organizationName ||
    "";
  const city = options?.city || pp?.city || null;
  const state = options?.state || pp?.state || null;
  const einFormatted = formatEinFromDigits(digits);
  const identity = orgName
    ? scoreOrgNameMatch(
        options?.organizationName?.trim() || orgName,
        orgName,
      )
    : { tier: "reject" as const, score: 0 };

  if (!pp && !eo) {
    if (!orgName) return null;
    const guessed = await guessNonprofitWebsite({
      organizationName: orgName,
      ein: einFormatted,
      city,
      state,
    });
    if (guessed.provider) providers.push(guessed.provider);
    const layer = await attachVerifiedContactLayer({
      organizationName: orgName,
      website: guessed.website,
      ein: einFormatted,
      city,
      state,
      mission: null,
      providers,
    });
    if (!layer.website && !layer.facebookUrl && !layer.instagramUrl) {
      return null;
    }
    return {
      ein: einFormatted,
      organizationName: orgName,
      website: layer.website,
      logoUrl: null,
      mission: layer.mission,
      city,
      state,
      zip: null,
      providers: layer.providers,
      facebookUrl: layer.facebookUrl,
      instagramUrl: layer.instagramUrl,
      linkedinUrl: layer.linkedinUrl,
      youtubeUrl: layer.youtubeUrl,
      tiktokUrl: layer.tiktokUrl,
      contactEmail: layer.contactEmail,
      contactPhone: layer.contactPhone,
      confidence: layer.confidence,
      identityMatch: identity.tier,
      verifiedWebsite: layer.verifiedWebsite,
    };
  }

  let website = eo?.website || null;
  if (!website && orgName) {
    const guessed = await guessNonprofitWebsite({
      organizationName: orgName,
      ein: einFormatted,
      city,
      state,
    });
    if (guessed.website) {
      website = guessed.website;
      if (guessed.provider) providers.push(guessed.provider);
    }
  }

  const layer = await attachVerifiedContactLayer({
    organizationName: orgName || eo?.organizationName || pp?.organizationName || "",
    website,
    ein: einFormatted,
    city,
    state,
    mission: eo?.mission || null,
    providers,
  });

  return {
    ein: einFormatted,
    organizationName: eo?.organizationName || pp?.organizationName || orgName || null,
    website: layer.website,
    logoUrl: eo?.logoUrl || null,
    mission: layer.mission,
    city: pp?.city || city,
    state: pp?.state || state,
    zip: pp?.zip || null,
    providers: layer.providers,
    facebookUrl: layer.facebookUrl,
    instagramUrl: layer.instagramUrl,
    linkedinUrl: layer.linkedinUrl,
    youtubeUrl: layer.youtubeUrl,
    tiktokUrl: layer.tiktokUrl,
    contactEmail: layer.contactEmail,
    contactPhone: layer.contactPhone,
    confidence: layer.confidence,
    identityMatch: identity.tier,
    verifiedWebsite: layer.verifiedWebsite,
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
 * Search US nonprofits (IRS via ProPublica), rank/filter by exact-org identity,
 * then enrich logos/websites via Every.org.
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

  // Pull a wider IRS page so identity filter still has exact matches to keep.
  const fetchCap = Math.min(25, Math.max(limit * 3, 15));
  const mapped = (body.organizations ?? [])
    .map(mapOrg)
    .filter((row): row is UsNonprofitSuggestion => row != null)
    .slice(0, fetchCap);

  const identityFiltered = filterByOrgIdentityMatch(q, mapped);
  const ranked: UsNonprofitSuggestion[] = identityFiltered
    .slice(0, limit)
    .map((row) => {
      const { identityMatch, identityScore: _score, ...rest } = row;
      void _score;
      const matchStrength: UsNonprofitSuggestion["matchStrength"] =
        identityMatch === "exact" || identityMatch === "near"
          ? "strong"
          : identityMatch === "partial"
            ? "partial"
            : "weak";
      return {
        ...rest,
        matchStrength,
        identityMatch,
      };
    });

  const enriched = await attachEveryOrgEnrichment(ranked);

  return {
    candidates: enriched,
    totalResults: typeof body.total_results === "number" ? body.total_results : enriched.length,
    provider: "propublica+every_org+identity",
  };
}
