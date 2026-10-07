"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOrgName = normalizeOrgName;
exports.orgNameTokens = orgNameTokens;
exports.scoreOrgNameMatch = scoreOrgNameMatch;
exports.identityTierRank = identityTierRank;
exports.filterByOrgIdentityMatch = filterByOrgIdentityMatch;
exports.isRejectedDirectoryHost = isRejectedDirectoryHost;
exports.extractPageIdentitySignals = extractPageIdentitySignals;
exports.verifyWebsiteBelongsToOrg = verifyWebsiteBelongsToOrg;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 400_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const WEAK_NAME_TOKENS = new Set([
    "the",
    "and",
    "for",
    "of",
    "to",
    "a",
    "an",
    "inc",
    "llc",
    "ltd",
    "org",
    "co",
    "corp",
    "corporation",
    "america",
    "american",
    "national",
    "united",
    "youth",
    "community",
    "foundation",
    "association",
    "society",
    "club",
    "team",
    "group",
    "school",
    "center",
    "centre",
    "inc.",
    "nonprofit",
    "non",
    "profit",
]);
const REJECT_HOST_FRAGMENTS = [
    "guidestar.org",
    "candid.org",
    "charitynavigator.org",
    "every.org",
    "propublica.org",
    "irs.gov",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "youtube.com",
    "youtu.be",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "gofundme.com",
    "networkforgood.com",
    "classy.org",
    "donorbox.org",
    "paypal.com",
    "wikipedia.org",
    "yelp.com",
    "yellowpages.com",
    "bbb.org",
];
function normalizeOrgName(raw) {
    return raw
        .trim()
        .toLowerCase()
        .replace(/^the\s+/, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function orgNameTokens(raw) {
    const norm = normalizeOrgName(raw);
    if (!norm)
        return [];
    return norm.split(" ").filter(Boolean);
}
function distinctiveTokens(tokens) {
    const out = tokens.filter((t) => t.length >= 2 && !WEAK_NAME_TOKENS.has(t));
    return out.length > 0 ? out : tokens.filter((t) => t.length >= 3);
}
function scoreOrgNameMatch(queryName, candidateName) {
    const q = normalizeOrgName(queryName);
    const c = normalizeOrgName(candidateName);
    if (!q || !c)
        return { tier: "reject", score: 0 };
    if (q === c)
        return { tier: "exact", score: 1 };
    const qCompact = q.replace(/\s+/g, "");
    const cCompact = c.replace(/\s+/g, "");
    if (qCompact.length >= 4 && qCompact === cCompact) {
        return { tier: "exact", score: 0.98 };
    }
    if (q.length >= 6 && (c.includes(q) || q.includes(c))) {
        return { tier: "near", score: 0.9 };
    }
    const qTok = distinctiveTokens(orgNameTokens(q));
    const cTok = distinctiveTokens(orgNameTokens(c));
    if (qTok.length === 0 || cTok.length === 0) {
        return { tier: "reject", score: 0 };
    }
    const cSet = new Set(cTok);
    const hit = qTok.filter((t) => cSet.has(t));
    const coverage = hit.length / qTok.length;
    const sharedCompact = qCompact.length >= 8 &&
        cCompact.length >= 8 &&
        (qCompact.includes(cCompact) || cCompact.includes(qCompact));
    if (coverage >= 1 && qTok.length >= 2) {
        return { tier: "exact", score: 0.95 };
    }
    if (coverage >= 1 && qTok.length === 1 && qTok[0].length >= 5) {
        return { tier: "near", score: 0.85 };
    }
    if (coverage >= 0.75 || sharedCompact) {
        return { tier: "near", score: 0.8 };
    }
    if (coverage >= 0.5) {
        return { tier: "partial", score: 0.55 };
    }
    if (coverage > 0) {
        return { tier: "weak", score: 0.25 };
    }
    return { tier: "reject", score: 0 };
}
function identityTierRank(tier) {
    if (tier === "exact")
        return 0;
    if (tier === "near")
        return 1;
    if (tier === "partial")
        return 2;
    if (tier === "weak")
        return 3;
    return 4;
}
function filterByOrgIdentityMatch(query, candidates) {
    const scored = candidates.map((c) => {
        const m = scoreOrgNameMatch(query, c.organizationName);
        return { ...c, identityMatch: m.tier, identityScore: m.score };
    });
    const hasStrong = scored.some((c) => c.identityMatch === "exact" || c.identityMatch === "near");
    const kept = scored.filter((c) => {
        if (c.identityMatch === "reject")
            return false;
        if (hasStrong && (c.identityMatch === "weak" || c.identityMatch === "partial")) {
            return false;
        }
        if (!hasStrong && c.identityMatch === "weak")
            return false;
        return true;
    });
    kept.sort((a, b) => {
        const tr = identityTierRank(a.identityMatch) - identityTierRank(b.identityMatch);
        if (tr !== 0)
            return tr;
        return b.identityScore - a.identityScore;
    });
    return kept;
}
function normalizeWebsite(raw) {
    const t = raw.trim();
    if (!t)
        return null;
    try {
        const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
        const u = new URL(withProto);
        if (u.protocol !== "http:" && u.protocol !== "https:")
            return null;
        return u.toString().replace(/\/$/, "") === `${u.origin}`
            ? `${u.origin}/`
            : u.toString();
    }
    catch {
        return null;
    }
}
function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    }
    catch {
        return "";
    }
}
function isRejectedDirectoryHost(url) {
    const host = hostOf(url);
    if (!host)
        return true;
    return REJECT_HOST_FRAGMENTS.some((frag) => host === frag || host.endsWith(`.${frag}`));
}
async function fetchHtml(url) {
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
        if (!res.ok)
            return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.slice(0, MAX_HTML_BYTES).toString("utf8");
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function websiteFetchVariants(url) {
    try {
        const u = new URL(url);
        const host = u.hostname;
        const alt = host.startsWith("www.")
            ? host.slice(4)
            : host.includes(".")
                ? `www.${host}`
                : host;
        const a = u.toString();
        u.hostname = alt;
        const b = u.toString();
        return a === b ? [a] : [a, b];
    }
    catch {
        return [url];
    }
}
function metaContent(html, patterns) {
    for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]?.trim()) {
            return m[1]
                .replace(/&#\d+;/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, '"')
                .replace(/\s+/g, " ")
                .trim();
        }
    }
    return "";
}
function extractPageIdentitySignals(html) {
    const title = metaContent(html, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
        /<title[^>]*>([^<]+)<\/title>/i,
    ]);
    const description = metaContent(html, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    ]);
    const siteName = metaContent(html, [
        /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    ]);
    const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
    return { title, description, siteName, textSample: stripped };
}
async function verifyWebsiteBelongsToOrg(params) {
    const organizationName = params.organizationName.trim();
    const website = normalizeWebsite(params.website);
    if (!organizationName || !website) {
        return {
            ok: false,
            website: null,
            confidence: "low",
            reason: "missing_name_or_url",
            pageTitle: null,
            pageDescription: null,
        };
    }
    if (isRejectedDirectoryHost(website)) {
        return {
            ok: false,
            website: null,
            confidence: "low",
            reason: "directory_or_social_host",
            pageTitle: null,
            pageDescription: null,
        };
    }
    const variants = websiteFetchVariants(website);
    const htmls = await Promise.all(variants.map((v) => fetchHtml(v)));
    const html = htmls.find((h) => h != null) ?? null;
    if (!html) {
        return {
            ok: false,
            website: null,
            confidence: "low",
            reason: "unreachable",
            pageTitle: null,
            pageDescription: null,
        };
    }
    const signals = extractPageIdentitySignals(html);
    const haystacks = [
        signals.siteName,
        signals.title,
        signals.description,
        signals.textSample.slice(0, 1500),
    ].filter(Boolean);
    let best = {
        tier: "reject",
        score: 0,
    };
    for (const hay of haystacks) {
        const m = scoreOrgNameMatch(organizationName, hay);
        if (m.score > best.score)
            best = m;
    }
    const host = hostOf(website).replace(/\.[a-z.]+$/i, "").replace(/[^a-z0-9]/g, "");
    const nameCompact = normalizeOrgName(organizationName).replace(/\s+/g, "");
    if (host.length >= 5 &&
        nameCompact.length >= 5 &&
        (host === nameCompact ||
            nameCompact.includes(host) ||
            host.includes(nameCompact.slice(0, Math.min(12, nameCompact.length))))) {
        if (best.score < 0.8) {
            best = { tier: "near", score: Math.max(best.score, 0.82) };
        }
    }
    const locationHint = [params.city?.trim(), params.state?.trim()]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const textLower = haystacks.join(" ").toLowerCase();
    if (locationHint && textLower.includes(locationHint.toLowerCase()) && best.score >= 0.5) {
        best = { tier: best.tier === "reject" ? "partial" : best.tier, score: Math.min(1, best.score + 0.05) };
    }
    if (best.tier === "exact" || best.tier === "near") {
        return {
            ok: true,
            website,
            confidence: best.tier === "exact" ? "high" : "medium",
            reason: `identity_${best.tier}`,
            pageTitle: signals.title || null,
            pageDescription: signals.description || null,
        };
    }
    if (best.tier === "partial" && best.score >= 0.55) {
        return {
            ok: true,
            website,
            confidence: "low",
            reason: "identity_partial",
            pageTitle: signals.title || null,
            pageDescription: signals.description || null,
        };
    }
    return {
        ok: false,
        website: null,
        confidence: "low",
        reason: `identity_${best.tier}`,
        pageTitle: signals.title || null,
        pageDescription: signals.description || null,
    };
}
//# sourceMappingURL=verify-nonprofit-identity.js.map