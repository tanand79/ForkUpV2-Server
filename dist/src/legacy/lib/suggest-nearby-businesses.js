"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestNearbyBusinesses = suggestNearbyBusinesses;
const ai_chat_1 = require("./ai-chat");
const geo_distance_1 = require("./geo-distance");
const join_door_type_1 = require("./join-door-type");
function cleanNearZip(raw) {
    if (typeof raw !== "string")
        return "";
    return raw.replace(/\D/g, "").slice(0, 5);
}
function clampLimit(raw) {
    const n = typeof raw === "number"
        ? raw
        : typeof raw === "string"
            ? Number(raw.trim())
            : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return 8;
    return Math.min(Math.max(Math.floor(n), 1), 15);
}
function normalizeWebsite(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function doorLabel(door) {
    if (door === "local")
        return "local business";
    if (door === "restaurant")
        return "restaurant";
    return "restaurant or local business";
}
function asTrimmedString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeCandidate(row, fallbackZip, fallbackCity, fallbackState) {
    const businessName = asTrimmedString(row.businessName) || asTrimmedString(row.name);
    if (!businessName || businessName.length > 200)
        return null;
    const city = asTrimmedString(row.city) || fallbackCity;
    const state = asTrimmedString(row.state).toUpperCase().slice(0, 2) || fallbackState;
    const address = asTrimmedString(row.address);
    const zipRaw = cleanNearZip(row.zip) || fallbackZip;
    const websiteRaw = asTrimmedString(row.website);
    const businessType = asTrimmedString(row.businessType);
    return {
        businessName,
        city,
        state,
        address,
        zip: zipRaw.length === 5 ? zipRaw : fallbackZip,
        website: websiteRaw ? normalizeWebsite(websiteRaw) : "",
        businessType,
    };
}
function dedupeCandidates(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const key = row.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}
async function nominatimNearbyCandidates(params) {
    const where = [params.city, params.state, params.nearZip]
        .filter(Boolean)
        .join(", ");
    if (!where)
        return [];
    const queryKind = params.joinDoorType === "local"
        ? "shop"
        : "restaurant";
    try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("format", "json");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", String(Math.min(params.limit, 15)));
        url.searchParams.set("countrycodes", "us");
        url.searchParams.set("q", `${queryKind} near ${where}, USA`);
        const res = await fetch(url.toString(), {
            headers: {
                "User-Agent": "ForkUp/1.0 (nearby business suggest; contact support@forkup.app)",
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok)
            return [];
        const data = (await res.json());
        const out = [];
        for (const hit of data) {
            const addr = hit.address;
            const name = (hit.name || "").trim() ||
                (addr?.amenity || "").trim() ||
                (addr?.shop || "").trim();
            if (!name)
                continue;
            const road = [addr?.house_number, addr?.road].filter(Boolean).join(" ").trim();
            const hitCity = addr?.city ||
                addr?.town ||
                addr?.village ||
                addr?.hamlet ||
                addr?.municipality ||
                params.city;
            const iso = (addr?.["ISO3166-2-lvl4"] || "").toUpperCase();
            const hitState = /^US-[A-Z]{2}$/.test(iso)
                ? iso.slice(3)
                : (addr?.state || "").length === 2
                    ? addr.state.toUpperCase()
                    : params.state;
            const hitZip = (addr?.postcode || params.nearZip || "").replace(/\D/g, "").slice(0, 5);
            out.push({
                businessName: name,
                city: hitCity || params.city,
                state: hitState || params.state,
                address: road,
                zip: hitZip.length === 5 ? hitZip : params.nearZip,
                website: "",
                businessType: queryKind,
            });
        }
        return dedupeCandidates(out).slice(0, params.limit);
    }
    catch {
        return [];
    }
}
async function suggestNearbyBusinesses(params) {
    const nearZip = cleanNearZip(params.nearZip);
    if (nearZip.length !== 5) {
        throw new Error("A valid 5-digit US ZIP is required.");
    }
    const joinDoorType = (0, join_door_type_1.normalizeJoinDoorType)(params.joinDoorType);
    const limit = clampLimit(params.limit);
    const place = await (0, geo_distance_1.resolveUsZip)(nearZip);
    const city = (typeof params.city === "string" ? params.city.trim() : "") ||
        place?.city ||
        "";
    const state = (typeof params.state === "string"
        ? params.state.trim().toUpperCase().slice(0, 2)
        : "") ||
        place?.state ||
        "";
    const label = doorLabel(joinDoorType);
    let candidates = [];
    let provider = "none";
    if ((0, ai_chat_1.aiProviderName)() !== "none") {
        const locationLine = [city, state, `ZIP ${nearZip}`]
            .filter(Boolean)
            .join(", ");
        const system = [
            `You help ForkUp list real, currently operating ${label}s near a US location.`,
            "Return ONLY JSON: {\"candidates\":[{\"businessName\",\"city\",\"state\",\"address\",\"zip\",\"website\",\"businessType\"}]}.",
            `Return up to ${limit} distinct venues that are actually near ${locationLine}.`,
            "Prefer well-known local venues over national chains when both exist.",
            "Use short street addresses when known; leave address/website empty strings when unsure.",
            "website must be the official public homepage when reasonably known; otherwise \"\".",
            "state must be a 2-letter US abbreviation. zip should be a 5-digit US ZIP near the venue.",
            "Never invent private emails or phones. Do not return directories, aggregators, or delivery apps as venues.",
            "If you are unsure of real nearby venues, return fewer candidates — never invent fake names.",
        ].join("\n");
        const user = [
            `Find nearby ${label}s.`,
            `Location: ${locationLine}`,
            joinDoorType ? `Door type: ${joinDoorType}` : null,
            `Limit: ${limit}`,
        ]
            .filter(Boolean)
            .join("\n");
        try {
            const content = await (0, ai_chat_1.aiChat)({
                system,
                user,
                json: true,
                maxTokens: 2048,
                temperature: 0.2,
            });
            const parsed = (0, ai_chat_1.parseAiJson)(content);
            const rawList = Array.isArray(parsed.candidates) ? parsed.candidates : [];
            const mapped = [];
            for (const item of rawList) {
                if (!item || typeof item !== "object")
                    continue;
                const c = normalizeCandidate(item, nearZip, city, state);
                if (c)
                    mapped.push(c);
            }
            candidates = dedupeCandidates(mapped).slice(0, limit);
            provider = (0, ai_chat_1.aiProviderName)();
        }
        catch {
            candidates = [];
            provider = (0, ai_chat_1.aiProviderName)();
        }
    }
    if (candidates.length === 0) {
        const osm = await nominatimNearbyCandidates({
            nearZip,
            city,
            state,
            joinDoorType,
            limit,
        });
        if (osm.length > 0) {
            candidates = osm;
            provider = provider === "none" ? "nominatim" : `${provider}+nominatim`;
        }
    }
    if (candidates.length === 0 && (0, ai_chat_1.aiProviderName)() === "none") {
        throw new Error("No AI provider configured and OSM nearby search returned no results.");
    }
    return {
        nearZip,
        city: city || null,
        state: state || null,
        joinDoorType,
        candidates,
        provider,
        matchCount: candidates.length,
    };
}
//# sourceMappingURL=suggest-nearby-businesses.js.map