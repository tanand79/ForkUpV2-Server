"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeProfileDomain = normalizeProfileDomain;
exports.findKnownOrganizationProfile = findKnownOrganizationProfile;
exports.findKnownOrganizationByName = findKnownOrganizationByName;
function normalizeProfileDomain(raw) {
    let s = raw.trim().toLowerCase();
    if (!s)
        return "";
    try {
        if (!/^https?:\/\//i.test(s))
            s = `https://${s}`;
        return new URL(s).hostname.replace(/^www\./, "");
    }
    catch {
        return s
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0] ?? "";
    }
}
const KNOWN_BY_DOMAIN = {
    "headstrong.org": {
        organizationName: "Headstrong Foundation",
        missionStatement: "Nonprofit supporting families facing cancer, inspired by lacrosse.",
        about: "Headstrong Foundation provides financial, residential, and emotional support to families affected by cancer.",
        contactEmail: "",
        phone: "",
        location: "Bryn Mawr, PA",
        causeCategory: "Health / Cancer Support",
        city: "Bryn Mawr",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Foundation",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "ymcagbw.org": {
        organizationName: "YMCA of Greater Brandywine",
        missionStatement: "Community organization supporting youth development, healthy living, and social responsibility.",
        about: "Community YMCA serving families across the Brandywine region.",
        contactEmail: "",
        phone: "",
        location: "West Chester, PA",
        causeCategory: "Community / Youth",
        city: "West Chester",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Community Organization",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "ymcade.org": {
        organizationName: "YMCA of Delaware",
        missionStatement: "Regional YMCA organization supporting youth, families, and community wellness.",
        about: "Statewide YMCA supporting healthy living and youth development.",
        contactEmail: "",
        phone: "",
        location: "Delaware",
        causeCategory: "Community / Youth",
        city: "",
        state: "DE",
        ein: "",
        orgType: "Nonprofit / Community Organization",
        social: ["Facebook"],
        outcome: "full",
    },
    "ymcawestchester.org": {
        organizationName: "YMCA of Greater West Chester",
        missionStatement: "Neighborhood YMCA offering youth programs and community services.",
        about: "Neighborhood YMCA offering youth programs and community services.",
        contactEmail: "",
        phone: "",
        location: "West Chester, PA",
        causeCategory: "Community / Youth",
        city: "West Chester",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Community Organization",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "wcyouthlacrosse.org": {
        organizationName: "West Chester Youth Lacrosse",
        missionStatement: "Youth lacrosse club supporting players, families, and local programs.",
        about: "Youth lacrosse club supporting players, families, and local programs.",
        contactEmail: "",
        phone: "",
        location: "West Chester, PA",
        causeCategory: "Youth Sports",
        city: "West Chester",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Youth Sports",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "greenmorerescue.org": {
        organizationName: "Greenmore Farm Animal Rescue",
        missionStatement: "Animal rescue organization helping farm animals and connecting the community with animal welfare.",
        about: "Animal rescue organization helping farm animals and connecting the community with animal welfare.",
        contactEmail: "",
        phone: "",
        location: "West Chester, PA",
        causeCategory: "Animals",
        city: "West Chester",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Animal Rescue",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "wclacrosseboosters.org": {
        organizationName: "WC Lacrosse Boosters",
        missionStatement: "Parent-run booster club raising funds for equipment and travel.",
        about: "Parent-run booster club raising funds for equipment and travel.",
        contactEmail: "",
        phone: "",
        location: "West Chester, PA",
        causeCategory: "Youth Sports",
        city: "West Chester",
        state: "PA",
        ein: "",
        orgType: "Nonprofit / Booster Club",
        social: ["Facebook"],
        outcome: "full",
    },
    "feedingamerica.org": {
        organizationName: "Feeding America",
        missionStatement: "Nationwide network of food banks working to end hunger in the United States through food rescue, meal programs, and community partnerships.",
        about: "Feeding America is the largest hunger-relief organization in the United States, supporting a nationwide network of food banks and meal programs so families and kids can access nutritious food.",
        contactEmail: "",
        phone: "",
        location: "Chicago, IL",
        causeCategory: "Hunger Relief / Food Security",
        city: "Chicago",
        state: "IL",
        ein: "36-3673599",
        orgType: "Nonprofit",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
    "redcross.org": {
        organizationName: "American Red Cross",
        missionStatement: "Prevents and alleviates human suffering in the face of emergencies by mobilizing the power of volunteers and the generosity of donors.",
        about: "The American Red Cross provides disaster relief, blood donation services, health and safety training, and support for military families across the United States.",
        contactEmail: "",
        phone: "",
        location: "Washington, DC",
        causeCategory: "Disaster Relief / Humanitarian",
        city: "Washington",
        state: "DC",
        ein: "53-0196605",
        orgType: "Nonprofit",
        social: ["Facebook", "Instagram"],
        outcome: "full",
    },
};
function findKnownOrganizationProfile(websiteOrDomain) {
    const domain = normalizeProfileDomain(websiteOrDomain);
    if (!domain)
        return null;
    const direct = KNOWN_BY_DOMAIN[domain];
    if (direct) {
        return { ...direct, website: `https://${domain}` };
    }
    for (const [key, profile] of Object.entries(KNOWN_BY_DOMAIN)) {
        if (domain === key || domain.endsWith(`.${key}`)) {
            return { ...profile, website: `https://${key}` };
        }
    }
    return null;
}
const WEAK_NAME_TOKENS = new Set([
    "the",
    "and",
    "for",
    "of",
    "inc",
    "llc",
    "org",
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
]);
function normalizeNameQuery(raw) {
    return raw
        .trim()
        .toLowerCase()
        .replace(/^the\s+/, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function findKnownOrganizationByName(nameQuery) {
    const q = normalizeNameQuery(nameQuery);
    if (!q || q.length < 3)
        return null;
    const compact = q.replace(/\s+/g, "");
    if (q.includes("headstrong") || q.includes("head strong")) {
        const hs = KNOWN_BY_DOMAIN["headstrong.org"];
        return { ...hs, website: "https://headstrong.org" };
    }
    if (q.includes("feeding america") || compact === "feedingamerica") {
        const fa = KNOWN_BY_DOMAIN["feedingamerica.org"];
        return { ...fa, website: "https://feedingamerica.org" };
    }
    if (q.includes("red cross") ||
        q.includes("american red cross") ||
        compact === "redcross" ||
        compact === "americanredcross") {
        const rc = KNOWN_BY_DOMAIN["redcross.org"];
        return { ...rc, website: "https://redcross.org" };
    }
    for (const [domain, profile] of Object.entries(KNOWN_BY_DOMAIN)) {
        const domainKey = domain.replace(/\.[a-z.]+$/i, "").replace(/[^a-z0-9]/g, "");
        if (compact.length >= 6 && domainKey === compact) {
            return { ...profile, website: `https://${domain}` };
        }
    }
    for (const [domain, profile] of Object.entries(KNOWN_BY_DOMAIN)) {
        const name = normalizeNameQuery(profile.organizationName);
        if (!name)
            continue;
        if (name === q || name.includes(q) || q.includes(name)) {
            return { ...profile, website: `https://${domain}` };
        }
    }
    const queryTokens = q.split(/\s+/).filter((t) => t.length > 3 && !WEAK_NAME_TOKENS.has(t));
    if (queryTokens.length === 0)
        return null;
    for (const [domain, profile] of Object.entries(KNOWN_BY_DOMAIN)) {
        const nameTokens = normalizeNameQuery(profile.organizationName)
            .split(/\s+/)
            .filter((t) => t.length > 3 && !WEAK_NAME_TOKENS.has(t));
        if (nameTokens.length === 0)
            continue;
        const hits = queryTokens.filter((t) => nameTokens.some((n) => n === t || n.startsWith(t) || t.startsWith(n)));
        if (hits.length >= 2) {
            return { ...profile, website: `https://${domain}` };
        }
        if (hits.length === 1 && hits[0].length >= 8) {
            return { ...profile, website: `https://${domain}` };
        }
    }
    return null;
}
//# sourceMappingURL=known-organization-profiles.js.map