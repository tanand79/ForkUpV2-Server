"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichUsNonprofitByEin = enrichUsNonprofitByEin;
exports.suggestUsNonprofits = suggestUsNonprofits;
const guess_nonprofit_website_1 = require("./guess-nonprofit-website");
const PROPUBLICA_SEARCH = "https://projects.propublica.org/nonprofits/api/v2/search.json";
const PROPUBLICA_ORG = "https://projects.propublica.org/nonprofits/api/v2/organizations";
const EVERY_ORG_DETAIL = "https://partners.every.org/v0.2/nonprofit";
const FETCH_TIMEOUT_MS = 4500;
const ENRICH_TIMEOUT_MS = 3500;
function displayOrgName(raw) {
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (!trimmed)
        return "";
    if (!/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) {
        return trimmed
            .toLowerCase()
            .split(" ")
            .map((w) => {
            if (w.length <= 3 && /^[a-z]+$/.test(w))
                return w.toUpperCase();
            return w.charAt(0).toUpperCase() + w.slice(1);
        })
            .join(" ");
    }
    return trimmed;
}
function digitsOnlyEin(raw) {
    return raw.replace(/\D/g, "").padStart(9, "0").slice(-9);
}
function formatEin(strein, ein) {
    if (strein && /^\d{2}-\d{7}$/.test(strein))
        return strein;
    if (ein == null || !Number.isFinite(ein))
        return null;
    const digits = String(Math.trunc(ein)).padStart(9, "0");
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}
function formatEinFromDigits(digits) {
    const d = digitsOnlyEin(digits);
    return `${d.slice(0, 2)}-${d.slice(2)}`;
}
function bumpLogoSize(logoUrl) {
    if (!logoUrl?.trim())
        return null;
    return logoUrl
        .replace(/w_24,h_24/g, "w_128,h_128")
        .replace(/w_48,h_48/g, "w_128,h_128");
}
function normalizeWebsite(raw) {
    const t = (raw ?? "").trim();
    if (!t)
        return null;
    if (/^https?:\/\//i.test(t))
        return t;
    return `https://${t}`;
}
function mapOrg(org) {
    const name = displayOrgName(org.name ?? "");
    if (!name)
        return null;
    const ein = formatEin(org.strein, org.ein);
    const zip = typeof org.zipcode === "string" && org.zipcode.trim()
        ? org.zipcode.trim().slice(0, 10)
        : null;
    const score = typeof org.score === "number" ? org.score : 0;
    const matchStrength = score >= 90 ? "strong" : score >= 60 ? "partial" : "weak";
    return {
        id: 0,
        organizationName: name,
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
async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchEveryOrgByEin(einDigits) {
    const body = await fetchJson(`${EVERY_ORG_DETAIL}/${einDigits}`, ENRICH_TIMEOUT_MS);
    const np = body?.data?.nonprofit;
    if (!np)
        return null;
    return {
        website: normalizeWebsite(np.websiteUrl),
        logoUrl: bumpLogoSize(np.logoUrl),
        mission: np.description?.trim() || null,
        organizationName: np.name?.trim() || null,
    };
}
async function fetchProPublicaDetail(einDigits) {
    const body = await fetchJson(`${PROPUBLICA_ORG}/${Number(einDigits)}.json`, ENRICH_TIMEOUT_MS);
    const org = body?.organization;
    if (!org)
        return null;
    return {
        organizationName: org.name ? displayOrgName(org.name) : null,
        city: org.city?.trim() || null,
        state: org.state?.trim() || null,
        zip: org.zipcode?.trim()?.slice(0, 10) || null,
    };
}
async function enrichUsNonprofitByEin(einRaw, options) {
    const digits = digitsOnlyEin(einRaw);
    if (!/^\d{9}$/.test(digits))
        return null;
    const providers = [];
    const [pp, eo] = await Promise.all([
        fetchProPublicaDetail(digits),
        fetchEveryOrgByEin(digits),
    ]);
    if (pp)
        providers.push("propublica");
    if (eo)
        providers.push("every_org");
    if (!pp && !eo) {
        const orgName = options?.organizationName?.trim() || "";
        if (!orgName)
            return null;
        const guessed = await (0, guess_nonprofit_website_1.guessNonprofitWebsite)({
            organizationName: orgName,
            ein: formatEinFromDigits(digits),
            city: options?.city || null,
            state: options?.state || null,
        });
        if (!guessed.website)
            return null;
        const providers = [];
        if (guessed.provider)
            providers.push(guessed.provider);
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
        const guessed = await (0, guess_nonprofit_website_1.guessNonprofitWebsite)({
            organizationName: orgName,
            ein: formatEinFromDigits(digits),
            city: options?.city || pp?.city || null,
            state: options?.state || pp?.state || null,
        });
        if (guessed.website) {
            website = guessed.website;
            if (guessed.provider)
                providers.push(guessed.provider);
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
async function attachEveryOrgEnrichment(candidates) {
    return Promise.all(candidates.map(async (c) => {
        if (!c.ein)
            return c;
        const eo = await fetchEveryOrgByEin(digitsOnlyEin(c.ein));
        if (!eo)
            return c;
        return {
            ...c,
            website: eo.website || c.website,
            logoUrl: eo.logoUrl || c.logoUrl,
            mission: eo.mission || c.mission,
        };
    }));
}
async function suggestUsNonprofits(params) {
    const q = params.q.trim();
    if (q.length < 2) {
        return { candidates: [], totalResults: 0, provider: "propublica" };
    }
    const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);
    const url = new URL(PROPUBLICA_SEARCH);
    url.searchParams.set("q", q);
    url.searchParams.set("page", "0");
    url.searchParams.set("c_code[id]", "3");
    const state = params.state?.trim().toUpperCase();
    if (state && /^[A-Z]{2}$/.test(state)) {
        url.searchParams.set("state[id]", state);
    }
    const body = await fetchJson(url.toString(), FETCH_TIMEOUT_MS);
    if (!body) {
        return { candidates: [], totalResults: 0, provider: "propublica" };
    }
    const mapped = (body.organizations ?? [])
        .map(mapOrg)
        .filter((row) => row != null)
        .slice(0, limit);
    const enriched = await attachEveryOrgEnrichment(mapped);
    return {
        candidates: enriched,
        totalResults: typeof body.total_results === "number" ? body.total_results : enriched.length,
        provider: "propublica+every_org",
    };
}
//# sourceMappingURL=us-nonprofit-directory.js.map