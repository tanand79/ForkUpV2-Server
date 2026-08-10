"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usNonprofitSuggestRouter = void 0;
const express_1 = require("express");
const us_nonprofit_directory_1 = require("../lib/us-nonprofit-directory");
const geo_distance_1 = require("../lib/geo-distance");
exports.usNonprofitSuggestRouter = (0, express_1.Router)();
function normCity(raw) {
    return (raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/\./g, "")
        .replace(/\s+/g, " ");
}
function cityKey(city, state) {
    return `city:${normCity(city)}|${state.trim().toUpperCase()}`;
}
async function prefetchCoords(keys, cache) {
    const unique = keys.filter((k) => !cache.has(k.key));
    const concurrency = 4;
    for (let i = 0; i < unique.length; i += concurrency) {
        const batch = unique.slice(i, i + concurrency);
        await Promise.all(batch.map(async (item) => {
            if (item.kind === "zip" && item.zip) {
                cache.set(item.key, await (0, geo_distance_1.geocodeUsZip)(item.zip));
                return;
            }
            if (item.kind === "city" && item.city && item.state) {
                cache.set(item.key, await (0, geo_distance_1.geocodeUsCityState)(item.city, item.state));
            }
        }));
    }
}
async function filterIrsCandidatesByNearby(candidates, origin, radiusMiles, resultLimit, preferredCity, preferredState) {
    const cache = new Map();
    const preferredCityNorm = normCity(preferredCity);
    const preferredStateNorm = (preferredState ?? "").trim().toUpperCase();
    const kept = [];
    const needGeo = [];
    for (const candidate of candidates) {
        const cCity = normCity(candidate.city);
        const cState = (candidate.state ?? "").trim().toUpperCase();
        if (preferredCityNorm &&
            preferredStateNorm &&
            cCity &&
            cCity === preferredCityNorm &&
            cState === preferredStateNorm) {
            kept.push({
                ...candidate,
                latitude: origin.latitude,
                longitude: origin.longitude,
                distanceMiles: 0,
            });
            continue;
        }
        needGeo.push(candidate);
    }
    if (kept.length >= resultLimit) {
        kept.sort((a, b) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));
        return kept.slice(0, resultLimit);
    }
    if (preferredCityNorm && preferredStateNorm) {
        const key = cityKey(preferredCityNorm, preferredStateNorm);
        if (!cache.has(key)) {
            cache.set(key, await (0, geo_distance_1.geocodeUsCityState)(preferredCity ?? "", preferredState ?? ""));
        }
    }
    const fetchKeys = [];
    for (const candidate of needGeo) {
        const zip = (candidate.zip ?? "").replace(/\D/g, "").slice(0, 5);
        if (zip.length === 5) {
            fetchKeys.push({ key: `zip:${zip}`, kind: "zip", zip });
            continue;
        }
        const city = (candidate.city ?? "").trim();
        const state = (candidate.state ?? "").trim();
        if (city && state) {
            fetchKeys.push({
                key: cityKey(city, state),
                kind: "city",
                city,
                state,
            });
        }
    }
    await prefetchCoords(fetchKeys, cache);
    for (const candidate of needGeo) {
        const zip = (candidate.zip ?? "").replace(/\D/g, "").slice(0, 5);
        let coords = null;
        if (zip.length === 5) {
            coords = cache.get(`zip:${zip}`) ?? null;
        }
        if (!coords) {
            const city = (candidate.city ?? "").trim();
            const state = (candidate.state ?? "").trim();
            if (city && state) {
                coords = cache.get(cityKey(city, state)) ?? null;
            }
        }
        if (!coords)
            continue;
        const distanceMiles = (0, geo_distance_1.milesBetween)(origin.latitude, origin.longitude, coords.latitude, coords.longitude);
        if (distanceMiles > radiusMiles)
            continue;
        kept.push({
            ...candidate,
            latitude: coords.latitude,
            longitude: coords.longitude,
            distanceMiles: Math.round(distanceMiles * 10) / 10,
        });
    }
    kept.sort((a, b) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));
    return kept.slice(0, resultLimit);
}
exports.usNonprofitSuggestRouter.get("/nonprofits/us-suggest", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        let state = typeof req.query.state === "string" ? req.query.state.trim() : "";
        const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
        const limit = Number.isFinite(limitRaw) ? limitRaw : 8;
        const origin = (0, geo_distance_1.parseLatLng)(req.query.lat, req.query.lng);
        const radiusMiles = (0, geo_distance_1.parseRadiusMiles)(req.query.radiusMiles);
        let derivedState = null;
        let derivedCity = null;
        if (!q) {
            res.status(400).json({ error: "q is required" });
            return;
        }
        if (origin) {
            const cityParam = typeof req.query.city === "string" ? req.query.city.trim() : "";
            if (cityParam)
                derivedCity = cityParam;
            if (!state || !derivedCity) {
                const geo = await (0, geo_distance_1.reverseGeocodeUs)(origin.latitude, origin.longitude);
                if (!state && geo?.state) {
                    state = geo.state;
                    derivedState = geo.state;
                }
                else if (state) {
                    derivedState = state.toUpperCase();
                }
                if (!derivedCity && geo?.city)
                    derivedCity = geo.city;
            }
            else {
                derivedState = state.toUpperCase();
            }
        }
        const fetchLimit = origin ? Math.min(25, Math.max(limit * 3, 20)) : limit;
        const result = await (0, us_nonprofit_directory_1.suggestUsNonprofits)({
            q,
            state: state || undefined,
            limit: fetchLimit,
        });
        let candidates = result.candidates;
        if (origin) {
            candidates = await filterIrsCandidatesByNearby(candidates, origin, radiusMiles, limit, derivedCity, derivedState || state || null);
        }
        else {
            candidates = candidates.slice(0, limit);
        }
        res.json({
            query: q,
            state: state || null,
            matchCount: candidates.length,
            totalResults: result.totalResults,
            provider: result.provider,
            candidates,
            nearby: origin
                ? {
                    latitude: origin.latitude,
                    longitude: origin.longitude,
                    derivedState,
                    derivedCity,
                    radiusMiles,
                    strict: true,
                }
                : null,
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to suggest US nonprofits" });
    }
});
exports.usNonprofitSuggestRouter.get("/nonprofits/us-enrich", async (req, res) => {
    try {
        const ein = typeof req.query.ein === "string" ? req.query.ein.trim() : "";
        if (!ein) {
            res.status(400).json({ error: "ein is required" });
            return;
        }
        const organizationName = typeof req.query.name === "string" ? req.query.name.trim() : "";
        const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
        const state = typeof req.query.state === "string" ? req.query.state.trim() : "";
        const enriched = await (0, us_nonprofit_directory_1.enrichUsNonprofitByEin)(ein, {
            organizationName: organizationName || undefined,
            city: city || undefined,
            state: state || undefined,
        });
        if (!enriched) {
            res.status(404).json({ error: "No enrichment found for that EIN" });
            return;
        }
        res.json(enriched);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to enrich US nonprofit" });
    }
});
//# sourceMappingURL=us-nonprofit-suggest.js.map