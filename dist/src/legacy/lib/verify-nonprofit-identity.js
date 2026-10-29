"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOrgName = normalizeOrgName;
exports.orgNameTokens = orgNameTokens;
exports.identityTokens = identityTokens;
exports.scoreOrgNameMatch = scoreOrgNameMatch;
exports.namesReferToSameOrg = namesReferToSameOrg;
exports.identityTierRank = identityTierRank;
exports.filterByOrgIdentityMatch = filterByOrgIdentityMatch;
exports.isRejectedDirectoryHost = isRejectedDirectoryHost;
exports.isUnsafeFetchUrl = isUnsafeFetchUrl;
exports.safeRedirectTarget = safeRedirectTarget;
exports.extractPageIdentitySignals = extractPageIdentitySignals;
exports.decideWebsiteIdentity = decideWebsiteIdentity;
exports.evidenceMatchesOrganization = evidenceMatchesOrganization;
exports.socialProfileMatchesOrg = socialProfileMatchesOrg;
exports.mergeKeepingTrustedIrs = mergeKeepingTrustedIrs;
exports.verifyWebsiteBelongsToOrg = verifyWebsiteBelongsToOrg;
const promises_1 = require("node:dns/promises");
const node_net_1 = require("node:net");
const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 400_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const LEGAL_SUFFIXES = new Set([
    "inc",
    "incorporated",
    "llc",
    "ltd",
    "corp",
    "corporation",
    "co",
    "company",
    "lp",
    "pllc",
]);
const OPTIONAL_ORG_TYPE = new Set([
    "foundation",
    "association",
    "organization",
    "organisation",
    "nonprofit",
]);
const GENERIC_SINGLE_TOKEN = new Set([
    "america",
    "american",
    "national",
    "united",
    "community",
    "youth",
    "foundation",
    "association",
    "center",
    "centre",
    "club",
    "school",
    "group",
    "team",
]);
const GENERIC_TITLE_TOKENS = new Set([
    "home",
    "welcome",
    "official",
    "site",
    "website",
    "homepage",
    "facebook",
    "instagram",
    "linkedin",
    "youtube",
    "twitter",
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
    return identityTokens(raw).join(" ");
}
function orgNameTokens(raw) {
    return identityTokens(raw);
}
function identityTokens(raw) {
    const norm = raw
        .trim()
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!norm)
        return [];
    const parts = norm.split(" ").filter(Boolean);
    if (parts[0] === "the" && parts.length > 1)
        parts.shift();
    while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1])) {
        parts.pop();
    }
    return parts;
}
function sameToken(a, b) {
    if (a === b)
        return true;
    if (a.length >= 4 && b.length >= 4 && (a + "s" === b || b + "s" === a))
        return true;
    return false;
}
function tokensEqual(a, b) {
    return a.length === b.length && a.every((t, i) => sameToken(t, b[i]));
}
function hasExtendingToken(query, candidate) {
    for (const q of query) {
        if (q.length < 3)
            continue;
        for (const c of candidate) {
            if (c.length < 3 || sameToken(q, c))
                continue;
            if (c.startsWith(q) || q.startsWith(c))
                return true;
        }
    }
    return false;
}
function withoutOrgType(tokens) {
    const core = tokens.filter((t) => !OPTIONAL_ORG_TYPE.has(t));
    return core.length > 0 ? core : tokens;
}
function containsContiguousPhrase(haystack, query) {
    if (query.length === 0 || haystack.length < query.length)
        return false;
    for (let i = 0; i <= haystack.length - query.length; i++) {
        if (query.every((t, j) => sameToken(haystack[i + j], t)))
            return true;
    }
    return false;
}
function scoreOrgNameMatch(queryName, candidateName) {
    const q = identityTokens(queryName);
    const c = identityTokens(candidateName);
    if (q.length === 0 || c.length === 0)
        return { tier: "reject", score: 0 };
    const qCompact = q.join("");
    const cCompact = c.join("");
    if (qCompact.length >= 4 && qCompact === cCompact) {
        return { tier: "exact", score: 1 };
    }
    if (hasExtendingToken(q, c))
        return { tier: "reject", score: 0 };
    if (tokensEqual(q, c))
        return { tier: "exact", score: 1 };
    const qCore = withoutOrgType(q);
    const cCore = withoutOrgType(c);
    if (qCore.length > 0 && tokensEqual(qCore, cCore)) {
        return { tier: "near", score: 0.92 };
    }
    if (c.length > q.length && containsContiguousPhrase(c, q)) {
        if (q.length === 1 && GENERIC_SINGLE_TOKEN.has(q[0])) {
            return { tier: "reject", score: 0 };
        }
        return { tier: "near", score: 0.9 };
    }
    return { tier: "reject", score: 0 };
}
function namesReferToSameOrg(queryName, candidateName) {
    const tier = scoreOrgNameMatch(queryName, candidateName).tier;
    return tier === "exact" || tier === "near";
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
function isNonPublicIp(ip) {
    const value = ip.toLowerCase();
    if (value.includes(":")) {
        if (value === "::1" || value === "::")
            return true;
        if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
            return true;
        }
        if (value.startsWith("::ffff:"))
            return isNonPublicIp(value.slice("::ffff:".length));
        return false;
    }
    const parts = value.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true;
    }
    const a = parts[0];
    const b = parts[1];
    if (a === 0 || a === 10 || a === 127 || a === 255)
        return true;
    if (a === 169 && b === 254)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    return false;
}
function isUnsafeFetchUrl(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:")
            return true;
        if (u.username || u.password)
            return true;
        const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
        if (!host)
            return true;
        if (host === "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            host.endsWith(".localdomain") ||
            host === "metadata.google.internal" ||
            host.endsWith(".metadata.google.internal") ||
            host === "instance-data") {
            return true;
        }
        if ((0, node_net_1.isIP)(host))
            return isNonPublicIp(host);
        return false;
    }
    catch {
        return true;
    }
}
function safeRedirectTarget(current, location) {
    try {
        const next = new URL(location, current).toString();
        return isUnsafeFetchUrl(next) ? null : next;
    }
    catch {
        return null;
    }
}
async function resolvesToPublicAddresses(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "");
    if ((0, node_net_1.isIP)(host))
        return !isNonPublicIp(host);
    try {
        const records = await (0, promises_1.lookup)(host, { all: true });
        if (records.length === 0)
            return false;
        return records.every((record) => !isNonPublicIp(record.address));
    }
    catch {
        return false;
    }
}
async function fetchHtml(url) {
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
        if (isUnsafeFetchUrl(current))
            return null;
        let hostname = "";
        try {
            hostname = new URL(current).hostname;
        }
        catch {
            return null;
        }
        if (!(await resolvesToPublicAddresses(hostname)))
            return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(current, {
                method: "GET",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    "User-Agent": BROWSER_UA,
                    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            });
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get("location");
                const next = loc ? safeRedirectTarget(current, loc) : null;
                if (!next)
                    return null;
                current = next;
                continue;
            }
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
    return null;
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
function isGenericTitle(title) {
    const tokens = identityTokens(title);
    if (tokens.length === 0)
        return true;
    return tokens.every((token) => GENERIC_TITLE_TOKENS.has(token));
}
function hostLabel(url) {
    const host = hostOf(url);
    const stem = host.split(".")[0] ?? "";
    return stem.replace(/[-_]+/g, " ");
}
function titleContradicts(organizationName, title) {
    if (!title.trim() || isGenericTitle(title))
        return false;
    return scoreOrgNameMatch(organizationName, title).tier === "reject";
}
function decideWebsiteIdentity(params) {
    const labels = [params.signals.siteName, params.signals.title]
        .flatMap((label) => label.split(/\s+[|–—-]\s+/))
        .map((label) => label.trim())
        .filter((label) => label && !isGenericTitle(label));
    let best = { tier: "reject", score: 0 };
    for (const label of labels) {
        const match = scoreOrgNameMatch(params.organizationName, label);
        if (match.score > best.score)
            best = match;
    }
    if (best.tier === "exact" || best.tier === "near") {
        return {
            ok: true,
            confidence: best.tier === "exact" ? "high" : "medium",
            reason: `identity_${best.tier}`,
        };
    }
    const contradicted = labels.some((label) => titleContradicts(params.organizationName, label));
    if (contradicted) {
        return { ok: false, confidence: "low", reason: "identity_reject" };
    }
    const hostMatch = scoreOrgNameMatch(params.organizationName, hostLabel(params.website));
    if (hostMatch.tier === "exact") {
        return { ok: true, confidence: "medium", reason: "identity_exact_host" };
    }
    return { ok: false, confidence: "low", reason: "identity_reject" };
}
function evidenceMatchesOrganization(organizationName, title, url) {
    if (isUnsafeFetchUrl(url) || isRejectedDirectoryHost(url))
        return false;
    const labels = title
        .split(/\s+[|–—-]\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (labels.some((label) => namesReferToSameOrg(organizationName, label)))
        return true;
    if (labels.some((label) => titleContradicts(organizationName, label)))
        return false;
    return scoreOrgNameMatch(organizationName, hostLabel(url)).tier === "exact";
}
function socialProfileMatchesOrg(organizationName, url, title = "") {
    if (isUnsafeFetchUrl(url))
        return false;
    if (title && !isGenericTitle(title)) {
        const titled = scoreOrgNameMatch(organizationName, title.split(/\s+[|–—-]\s+/)[0] ?? title);
        if (titled.tier === "reject")
            return false;
        if (titled.tier === "exact" || titled.tier === "near")
            return true;
    }
    try {
        const parts = new URL(url).pathname.split("/").filter(Boolean);
        const skip = new Set([
            "p",
            "posts",
            "reel",
            "reels",
            "watch",
            "channel",
            "c",
            "user",
            "in",
            "company",
            "school",
            "showcase",
            "share",
        ]);
        const seg = [...parts].reverse().find((part) => !skip.has(part.toLowerCase())) ?? "";
        const slug = decodeURIComponent(seg).replace(/^@/, "").replace(/[-_.]+/g, " ");
        if (!slug)
            return false;
        return namesReferToSameOrg(organizationName, slug);
    }
    catch {
        return false;
    }
}
function mergeKeepingTrustedIrs(irs, candidate) {
    if (candidate.identityTier !== "exact" && candidate.identityTier !== "near")
        return irs;
    const irsEin = (irs.ein ?? "").replace(/\D/g, "");
    const candidateEin = (candidate.ein ?? "").replace(/\D/g, "");
    if (irsEin && candidateEin && irsEin !== candidateEin)
        return irs;
    return {
        ...irs,
        organizationName: irs.organizationName,
        ein: irs.ein,
        website: irs.website?.trim() || candidate.website?.trim() || null,
        contactEmail: irs.contactEmail?.trim() || candidate.contactEmail?.trim() || null,
        contactPhone: irs.contactPhone?.trim() || candidate.contactPhone?.trim() || null,
    };
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
    if (isUnsafeFetchUrl(website) || isRejectedDirectoryHost(website)) {
        return {
            ok: false,
            website: null,
            confidence: "low",
            reason: isUnsafeFetchUrl(website) ? "unsafe_url" : "directory_or_social_host",
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
    const decision = decideWebsiteIdentity({
        organizationName,
        website,
        signals,
    });
    if (!decision.ok) {
        return {
            ok: false,
            website: null,
            confidence: "low",
            reason: decision.reason,
            pageTitle: signals.title || null,
            pageDescription: signals.description || null,
        };
    }
    return {
        ok: true,
        website,
        confidence: decision.confidence,
        reason: decision.reason,
        pageTitle: signals.title || null,
        pageDescription: signals.description || null,
    };
}
//# sourceMappingURL=verify-nonprofit-identity.js.map