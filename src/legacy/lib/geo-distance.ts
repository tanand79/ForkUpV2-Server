/**
 * Geo distance helpers for nearby (~8 mile) filtering.
 *
 * Purpose: Parse lat/lng/radius query params, compute Haversine distance in miles,
 * and geocode US ZIP centroids (Zippopotam.us — no API key).
 *
 * Inputs/outputs documented per export. Additive utility only — not tied to Express.
 */

/** Default product radius for nonprofit nearby filters. */
export const DEFAULT_NEARBY_RADIUS_MILES = 50;

export type LatLng = { latitude: number; longitude: number };

/**
 * Parse latitude/longitude from query-string style values.
 *
 * Inputs: raw lat and lng (string | number | undefined).
 * Outputs: LatLng when both are finite numbers in valid ranges; otherwise null.
 */
export function parseLatLng(
  latRaw: unknown,
  lngRaw: unknown,
): LatLng | null {
  const latitude =
    typeof latRaw === "number"
      ? latRaw
      : typeof latRaw === "string"
        ? Number(latRaw.trim())
        : NaN;
  const longitude =
    typeof lngRaw === "number"
      ? lngRaw
      : typeof lngRaw === "string"
        ? Number(lngRaw.trim())
        : NaN;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/**
 * Parse radius in miles; falls back to DEFAULT_NEARBY_RADIUS_MILES.
 *
 * Inputs: raw radius (string | number | undefined), optional defaultMiles.
 * Outputs: clamped positive number (0.1 .. 100).
 */
export function parseRadiusMiles(
  raw: unknown,
  defaultMiles = DEFAULT_NEARBY_RADIUS_MILES,
): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return defaultMiles;
  return Math.min(Math.max(n, 0.1), 100);
}

/**
 * Haversine distance in miles between two WGS84 points.
 *
 * Inputs: origin and target lat/lng.
 * Outputs: distance in miles (non-negative).
 */
export function milesBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthMiles * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a point is within radiusMiles of origin.
 *
 * Inputs: origin, target coords, radiusMiles.
 * Outputs: true when distance <= radiusMiles.
 */
export function isWithinRadiusMiles(
  origin: LatLng,
  targetLat: number,
  targetLng: number,
  radiusMiles: number,
): boolean {
  return (
    milesBetween(
      origin.latitude,
      origin.longitude,
      targetLat,
      targetLng,
    ) <= radiusMiles
  );
}

/**
 * Keep a row when it is within radius of origin.
 *
 * Inputs:
 * - origin (or null = keep all)
 * - optional row lat/lng
 * - radiusMiles
 * - options.requireCoordinates — when true and origin is set, NULL coords are dropped
 *   (strict Find Your Organization nearby mode).
 *
 * Outputs: { keep: boolean, distanceMiles: number | null }.
 */
export function nearbyKeepDecision(
  origin: LatLng | null,
  rowLat: number | null | undefined,
  rowLng: number | null | undefined,
  radiusMiles: number,
  options?: { requireCoordinates?: boolean },
): { keep: boolean; distanceMiles: number | null } {
  if (!origin) return { keep: true, distanceMiles: null };
  if (
    rowLat == null ||
    rowLng == null ||
    !Number.isFinite(Number(rowLat)) ||
    !Number.isFinite(Number(rowLng))
  ) {
    // Soft (default): keep unmapped rows. Strict: hide them when GPS is active.
    return {
      keep: options?.requireCoordinates ? false : true,
      distanceMiles: null,
    };
  }
  const distanceMiles = milesBetween(
    origin.latitude,
    origin.longitude,
    Number(rowLat),
    Number(rowLng),
  );
  return {
    keep: distanceMiles <= radiusMiles,
    distanceMiles: Math.round(distanceMiles * 10) / 10,
  };
}

type ZippopotamPlace = {
  latitude?: string;
  longitude?: string;
  "place name"?: string;
  "state abbreviation"?: string;
};

type ZippopotamResponse = {
  places?: ZippopotamPlace[];
};

/**
 * Geocode a US ZIP to lat/lng via Zippopotam.us (no API key).
 *
 * Inputs: 5-digit ZIP string (extra chars ignored).
 * Outputs: LatLng or null when not found / request fails.
 */
export async function geocodeUsZip(
  zipRaw: string,
): Promise<LatLng | null> {
  const place = await resolveUsZip(zipRaw);
  if (!place) return null;
  return { latitude: place.latitude, longitude: place.longitude };
}

export type UsZipPlace = LatLng & {
  zip: string;
  city: string | null;
  state: string | null;
};

/**
 * Resolve a US ZIP to coordinates + city/state (Zippopotam.us).
 *
 * Inputs: ZIP string (digits extracted; needs 5 digits).
 * Outputs: UsZipPlace or null when not found / request fails.
 */
export async function resolveUsZip(
  zipRaw: string,
): Promise<UsZipPlace | null> {
  const zip = zipRaw.replace(/\D/g, "").slice(0, 5);
  if (zip.length !== 5) return null;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ZippopotamResponse;
    const place = data.places?.[0];
    if (!place?.latitude || !place?.longitude) return null;
    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const stateAbbr = (place["state abbreviation"] ?? "").trim().toUpperCase();
    return {
      zip,
      latitude,
      longitude,
      city: place["place name"]?.trim() || null,
      state: /^[A-Z]{2}$/.test(stateAbbr) ? stateAbbr : null,
    };
  } catch {
    return null;
  }
}

/**
 * Geocode a US city + state to lat/lng.
 * Prefer Zippopotam (stable, no key); fall back to Nominatim.
 *
 * Inputs: city, state (2-letter preferred).
 * Outputs: LatLng or null.
 */
export async function geocodeUsCityState(
  cityRaw: string,
  stateRaw: string,
): Promise<LatLng | null> {
  const city = cityRaw.trim();
  const state = stateRaw.trim().toUpperCase();
  if (!city || !state) return null;

  const fromZippo = await geocodeUsCityStateZippopotam(city, state);
  if (fromZippo) return fromZippo;

  return geocodeUsCityStateNominatim(city, state);
}

async function geocodeUsCityStateZippopotam(
  city: string,
  state: string,
): Promise<LatLng | null> {
  if (!/^[A-Z]{2}$/.test(state)) return null;
  try {
    const place = encodeURIComponent(city.toLowerCase());
    const res = await fetch(`https://api.zippopotam.us/us/${state}/${place}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ZippopotamResponse;
    const hit = data.places?.[0];
    if (!hit?.latitude || !hit?.longitude) return null;
    const latitude = Number(hit.latitude);
    const longitude = Number(hit.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

async function geocodeUsCityStateNominatim(
  city: string,
  state: string,
): Promise<LatLng | null> {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");
    url.searchParams.set("q", `${city}, ${state}, USA`);
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "ForkUp/1.0 (nearby nonprofit search; contact support@forkup.app)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const hit = data[0];
    if (!hit?.lat || !hit?.lon) return null;
    const latitude = Number(hit.lat);
    const longitude = Number(hit.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

type NominatimReverse = {
  address?: {
    state?: string;
    city?: string;
    town?: string;
    village?: string;
    postcode?: string;
    "ISO3166-2-lvl4"?: string;
  };
};

/**
 * Reverse-geocode browser GPS to US city/state/zip (OpenStreetMap Nominatim,
 * with BigDataCloud fallback when Nominatim is rate-limited).
 *
 * Inputs: latitude, longitude.
 * Outputs: { city, state, zip } best-effort; null on failure.
 */
export async function reverseGeocodeUs(
  latitude: number,
  longitude: number,
): Promise<{ city: string | null; state: string | null; zip: string | null } | null> {
  const fromNominatim = await reverseGeocodeUsNominatim(latitude, longitude);
  if (fromNominatim?.state) return fromNominatim;

  const fromBdc = await reverseGeocodeUsBigDataCloud(latitude, longitude);
  if (fromBdc?.state) return fromBdc;

  return fromNominatim ?? fromBdc;
}

async function reverseGeocodeUsNominatim(
  latitude: number,
  longitude: number,
): Promise<{ city: string | null; state: string | null; zip: string | null } | null> {
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
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimReverse;
    const addr = data.address;
    if (!addr) return null;
    let state: string | null = null;
    const iso = addr["ISO3166-2-lvl4"];
    if (iso && /^US-[A-Z]{2}$/i.test(iso)) {
      state = iso.slice(3).toUpperCase();
    } else if (addr.state && /^[A-Za-z]{2}$/.test(addr.state.trim())) {
      state = addr.state.trim().toUpperCase();
    }
    const city = addr.city || addr.town || addr.village || null;
    const zip = addr.postcode?.replace(/\D/g, "").slice(0, 5) || null;
    return { city, state, zip };
  } catch {
    return null;
  }
}

type BigDataCloudReverse = {
  city?: string;
  locality?: string;
  principalSubdivisionCode?: string;
  postcode?: string;
  countryCode?: string;
};

async function reverseGeocodeUsBigDataCloud(
  latitude: number,
  longitude: number,
): Promise<{ city: string | null; state: string | null; zip: string | null } | null> {
  try {
    const url = new URL(
      "https://api.bigdatacloud.net/data/reverse-geocode-client",
    );
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("localityLanguage", "en");
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BigDataCloudReverse;
    if ((data.countryCode ?? "").toUpperCase() !== "US") {
      // Still return city if present for messaging, but no US state for IRS filter.
      return {
        city: data.city || data.locality || null,
        state: null,
        zip: data.postcode?.replace(/\D/g, "").slice(0, 5) || null,
      };
    }
    const subdiv = (data.principalSubdivisionCode ?? "").trim().toUpperCase();
    const state = /^US-[A-Z]{2}$/.test(subdiv)
      ? subdiv.slice(3)
      : /^[A-Z]{2}$/.test(subdiv)
        ? subdiv
        : null;
    return {
      city: data.city || data.locality || null,
      state,
      zip: data.postcode?.replace(/\D/g, "").slice(0, 5) || null,
    };
  } catch {
    return null;
  }
}

export type NamedBusinessPlace = {
  address: string;
  city: string;
  state: string;
  zip: string;
  displayName: string;
};

type NominatimSearchHit = {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    municipality?: string;
    state?: string;
    "ISO3166-2-lvl4"?: string;
    postcode?: string;
  };
};

/**
 * Find a named business place near a US ZIP / city (OpenStreetMap Nominatim).
 * Used when chain HQ sites lack a single store address (e.g. "Starbucks" + ZIP).
 */
export async function searchNamedBusinessNear(
  businessName: string,
  near: { zip?: string; city?: string; state?: string },
): Promise<NamedBusinessPlace | null> {
  const name = businessName.trim();
  if (!name || name.length > 200) return null;

  let zip = (near.zip || "").replace(/\D/g, "").slice(0, 5);
  let city = (near.city || "").trim();
  let state = (near.state || "").trim().toUpperCase().slice(0, 2);

  if (zip.length === 5 && (!city || !state)) {
    const place = await resolveUsZip(zip);
    if (place) {
      city = city || place.city || "";
      state = state || place.state || "";
    }
  }

  const where =
    zip.length === 5
      ? zip
      : [city, state].filter(Boolean).join(", ") || "";
  if (!where) return null;

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "us");
    url.searchParams.set("q", `${name}, ${where}, USA`);
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "ForkUp/1.0 (business join nearby; contact support@forkup.app)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimSearchHit[];
    for (const hit of data) {
      const addr = hit.address;
      if (!addr) continue;
      const road = [addr.house_number, addr.road].filter(Boolean).join(" ").trim();
      const hitCity =
        addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || "";
      const iso = (addr["ISO3166-2-lvl4"] || "").toUpperCase();
      const hitState = /^US-[A-Z]{2}$/.test(iso)
        ? iso.slice(3)
        : (addr.state || "").length === 2
          ? addr.state!.toUpperCase()
          : state;
      const hitZip = (addr.postcode || zip || "").replace(/\D/g, "").slice(0, 5);
      if (!road && !hitCity) continue;
      return {
        address: road,
        city: hitCity || city,
        state: hitState || state,
        zip: hitZip.length === 5 ? hitZip : zip,
        displayName: (hit.display_name || name).trim(),
      };
    }
    return null;
  } catch {
    return null;
  }
}
