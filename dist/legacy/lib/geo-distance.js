"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_NEARBY_RADIUS_MILES = void 0;
exports.parseLatLng = parseLatLng;
exports.parseRadiusMiles = parseRadiusMiles;
exports.milesBetween = milesBetween;
exports.isWithinRadiusMiles = isWithinRadiusMiles;
exports.nearbyKeepDecision = nearbyKeepDecision;
exports.geocodeUsZip = geocodeUsZip;
exports.reverseGeocodeUs = reverseGeocodeUs;
exports.DEFAULT_NEARBY_RADIUS_MILES = 8;
function parseLatLng(latRaw, lngRaw) {
    const latitude = typeof latRaw === "number"
        ? latRaw
        : typeof latRaw === "string"
            ? Number(latRaw.trim())
            : NaN;
    const longitude = typeof lngRaw === "number"
        ? lngRaw
        : typeof lngRaw === "string"
            ? Number(lngRaw.trim())
            : NaN;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return null;
    if (latitude < -90 || latitude > 90)
        return null;
    if (longitude < -180 || longitude > 180)
        return null;
    return { latitude, longitude };
}
function parseRadiusMiles(raw, defaultMiles = exports.DEFAULT_NEARBY_RADIUS_MILES) {
    const n = typeof raw === "number"
        ? raw
        : typeof raw === "string"
            ? Number(raw.trim())
            : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return defaultMiles;
    return Math.min(Math.max(n, 0.1), 100);
}
function milesBetween(aLat, aLng, bLat, bLng) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthMiles = 3958.7613;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthMiles * Math.asin(Math.min(1, Math.sqrt(h)));
}
function isWithinRadiusMiles(origin, targetLat, targetLng, radiusMiles) {
    return (milesBetween(origin.latitude, origin.longitude, targetLat, targetLng) <= radiusMiles);
}
function nearbyKeepDecision(origin, rowLat, rowLng, radiusMiles) {
    if (!origin)
        return { keep: true, distanceMiles: null };
    if (rowLat == null ||
        rowLng == null ||
        !Number.isFinite(Number(rowLat)) ||
        !Number.isFinite(Number(rowLng))) {
        return { keep: true, distanceMiles: null };
    }
    const distanceMiles = milesBetween(origin.latitude, origin.longitude, Number(rowLat), Number(rowLng));
    return {
        keep: distanceMiles <= radiusMiles,
        distanceMiles: Math.round(distanceMiles * 10) / 10,
    };
}
async function geocodeUsZip(zipRaw) {
    const zip = zipRaw.replace(/\D/g, "").slice(0, 5);
    if (zip.length !== 5)
        return null;
    try {
        const res = await fetch(`https://api.zippopotam.us/us/${zip}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        const place = data.places?.[0];
        if (!place?.latitude || !place?.longitude)
            return null;
        const latitude = Number(place.latitude);
        const longitude = Number(place.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
            return null;
        return { latitude, longitude };
    }
    catch {
        return null;
    }
}
async function reverseGeocodeUs(latitude, longitude) {
    try {
        const url = new URL("https://nominatim.openstreetmap.org/reverse");
        url.searchParams.set("format", "json");
        url.searchParams.set("lat", String(latitude));
        url.searchParams.set("lon", String(longitude));
        url.searchParams.set("zoom", "10");
        url.searchParams.set("addressdetails", "1");
        const res = await fetch(url.toString(), {
            headers: {
                "User-Agent": "ForkUp/1.0 (nearby nonprofit search; contact support@forkup.app)",
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        const addr = data.address;
        if (!addr)
            return null;
        let state = null;
        const iso = addr["ISO3166-2-lvl4"];
        if (iso && /^US-[A-Z]{2}$/i.test(iso)) {
            state = iso.slice(3).toUpperCase();
        }
        else if (addr.state && /^[A-Za-z]{2}$/.test(addr.state.trim())) {
            state = addr.state.trim().toUpperCase();
        }
        const city = addr.city || addr.town || addr.village || null;
        const zip = addr.postcode?.replace(/\D/g, "").slice(0, 5) || null;
        return { city, state, zip };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=geo-distance.js.map