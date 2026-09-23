"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyBookingPlatformUrl = classifyBookingPlatformUrl;
exports.extractBookingPlatformLink = extractBookingPlatformLink;
function partsOf(pathname) {
    return pathname.toLowerCase().split("/").filter(Boolean);
}
const BOOKING_RULES = [
    {
        host: "resy.com",
        platform: "resy",
        label: "Resy",
        rank: 1,
        pathOk: (p) => {
            const parts = partsOf(p);
            return parts[0] === "cities" && parts.length >= 3;
        },
    },
    {
        host: "opentable.com",
        platform: "opentable",
        label: "OpenTable",
        rank: 2,
        pathOk: (p) => {
            const parts = partsOf(p);
            return parts[0] === "r" || parts.includes("restaurant") || p.toLowerCase().includes("/booking/");
        },
    },
    {
        host: "exploretock.com",
        platform: "tock",
        label: "Tock",
        rank: 3,
        pathOk: (p) => partsOf(p).length >= 1 && partsOf(p)[0] !== "search",
    },
    {
        host: "tock.com",
        platform: "tock",
        label: "Tock",
        rank: 3,
        pathOk: (p) => partsOf(p).length >= 1 && partsOf(p)[0] !== "search",
    },
    {
        host: "sevenrooms.com",
        platform: "sevenrooms",
        label: "SevenRooms",
        rank: 4,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "thefork.com",
        platform: "thefork",
        label: "TheFork",
        rank: 5,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "quandoo.com",
        platform: "quandoo",
        label: "Quandoo",
        rank: 6,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "resdiary.com",
        platform: "resdiary",
        label: "ResDiary",
        rank: 7,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "zenchef.com",
        platform: "zenchef",
        label: "Zenchef",
        rank: 8,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "covermanager.com",
        platform: "covermanager",
        label: "CoverManager",
        rank: 9,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "yelp.com",
        platform: "yelp",
        label: "Yelp",
        rank: 10,
        pathOk: (p) => p.toLowerCase().includes("reservation"),
    },
    {
        host: "mindbodyonline.com",
        platform: "mindbody",
        label: "Mindbody",
        rank: 11,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "vagaro.com",
        platform: "vagaro",
        label: "Vagaro",
        rank: 12,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "calendly.com",
        platform: "calendly",
        label: "Calendly",
        rank: 13,
        pathOk: (p) => partsOf(p).length >= 1,
    },
    {
        host: "squareup.com",
        platform: "square",
        label: "Square",
        rank: 14,
        pathOk: (p) => p.toLowerCase().includes("appointment"),
    },
    {
        host: "acuityscheduling.com",
        platform: "acuity",
        label: "Acuity",
        rank: 15,
        pathOk: (p) => partsOf(p).length >= 1,
    },
];
function ruleForHost(hostname) {
    const host = hostname.replace(/^www\./i, "").toLowerCase();
    for (const rule of BOOKING_RULES) {
        if (host === rule.host || host.endsWith(`.${rule.host}`))
            return rule;
    }
    return null;
}
function classifyBookingPlatformUrl(raw) {
    const trimmed = raw.trim().replace(/[),.;]+$/, "");
    if (!trimmed || trimmed.length > 512)
        return null;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return null;
    const rule = ruleForHost(parsed.hostname);
    if (!rule || !rule.pathOk(parsed.pathname))
        return null;
    parsed.protocol = "https:";
    parsed.search = "";
    parsed.hash = "";
    const url = parsed.toString();
    if (url.length > 512)
        return null;
    return { platform: rule.platform, label: rule.label, url };
}
function extractBookingPlatformLink(html) {
    if (!html)
        return null;
    const decoded = html.replace(/&amp;/gi, "&");
    const re = /https?:\/\/[^\s"'<>\\]+/gi;
    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let match;
    while ((match = re.exec(decoded))) {
        const link = classifyBookingPlatformUrl(match[0]);
        if (!link)
            continue;
        const rank = BOOKING_RULES.find((r) => r.platform === link.platform)?.rank ?? 50;
        if (rank < bestRank) {
            best = link;
            bestRank = rank;
        }
    }
    return best;
}
//# sourceMappingURL=booking-platform-links.js.map