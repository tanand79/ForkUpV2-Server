"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googlePlacesConfigured = googlePlacesConfigured;
exports.searchGooglePlace = searchGooglePlace;
function googlePlacesConfigured() {
    return Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
}
function parseAddressComponents(components) {
    if (!Array.isArray(components)) {
        return { city: null, state: null, zip: null };
    }
    let city = null;
    let state = null;
    let zip = null;
    for (const raw of components) {
        if (!raw || typeof raw !== "object")
            continue;
        const c = raw;
        const types = Array.isArray(c.types) ? c.types : [];
        const longText = typeof c.longText === "string" ? c.longText.trim() : "";
        const shortText = typeof c.shortText === "string" ? c.shortText.trim() : "";
        if (types.includes("locality") && longText)
            city = longText;
        if (types.includes("administrative_area_level_1") && shortText) {
            state = shortText.slice(0, 2).toUpperCase();
        }
        if (types.includes("postal_code") && longText) {
            zip = longText.replace(/\D/g, "").slice(0, 5) || null;
        }
    }
    return { city, state, zip };
}
async function searchGooglePlace(params) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
    if (!apiKey)
        return null;
    const name = params.businessName.trim();
    if (name.length < 2 || name.length > 200)
        return null;
    const nearParts = [params.city, params.state, params.zip]
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean);
    const textQuery = nearParts.length > 0 ? `${name} ${nearParts.join(" ")}` : name;
    const fieldMask = [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.addressComponents",
        "places.websiteUri",
        "places.nationalPhoneNumber",
        "places.internationalPhoneNumber",
        "places.photos",
    ].join(",");
    try {
        const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            signal: AbortSignal.any([
                params.signal ?? AbortSignal.timeout(20_000),
                AbortSignal.timeout(20_000),
            ]),
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask": fieldMask,
            },
            body: JSON.stringify({
                textQuery,
                languageCode: "en",
                maxResultCount: 5,
                regionCode: "US",
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error("google-places searchText failed:", response.status, body.slice(0, 200));
            return null;
        }
        const json = (await response.json());
        const places = Array.isArray(json.places) ? json.places : [];
        if (places.length === 0)
            return null;
        const place = places[0];
        const displayName = place.displayName && typeof place.displayName === "object"
            ? String(place.displayName.text || "").trim()
            : "";
        const websiteRaw = typeof place.websiteUri === "string" ? place.websiteUri.trim() : "";
        const phoneRaw = (typeof place.nationalPhoneNumber === "string" &&
            place.nationalPhoneNumber.trim()) ||
            (typeof place.internationalPhoneNumber === "string" &&
                place.internationalPhoneNumber.trim()) ||
            "";
        const formattedAddress = typeof place.formattedAddress === "string"
            ? place.formattedAddress.trim()
            : null;
        const { city, state, zip } = parseAddressComponents(place.addressComponents);
        const photoNames = [];
        if (Array.isArray(place.photos)) {
            for (const photo of place.photos) {
                if (!photo || typeof photo !== "object")
                    continue;
                const n = photo.name;
                if (typeof n === "string" && n.trim()) {
                    photoNames.push(n.trim());
                    if (photoNames.length >= 6)
                        break;
                }
            }
        }
        const placeId = typeof place.id === "string" && place.id.trim()
            ? place.id.trim()
            : typeof place.name === "string"
                ? place.name.trim()
                : "";
        if (!placeId && !displayName && !websiteRaw)
            return null;
        return {
            placeId: placeId || displayName || textQuery,
            name: displayName || name,
            website: websiteRaw || null,
            phone: phoneRaw || null,
            formattedAddress,
            city,
            state,
            zip,
            photoNames,
            provider: "google_places",
        };
    }
    catch (err) {
        if (params.signal?.aborted)
            throw err;
        console.error("google-places searchText error:", err instanceof Error ? err.message.slice(0, 200) : err);
        return null;
    }
}
//# sourceMappingURL=google-places-client.js.map