/**
 * Geo distance helpers for nearby (~8 mile) filtering.
 *
 * Purpose: Parse lat/lng/radius query params, compute Haversine distance in miles,
 * and geocode US ZIP centroids (Zippopotam.us — no API key).
 *
 * Inputs/outputs documented per export. Additive utility only — not tied to Express.
 */

/** Default product radius for nonprofit nearby filters. */
export const DEFAULT_NEARBY_RADIUS_MILES = 8;

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
 * Keep a row when it has no coordinates, or when it is within radius.
 * Matches product rule: NULL coords stay visible until backfill.
 *
 * Inputs: origin (or null = keep all), optional row lat/lng, radiusMiles.
 * Outputs: { keep: boolean, distanceMiles: number | null }.
 */
export function nearbyKeepDecision(
  origin: LatLng | null,
  rowLat: number | null | undefined,
  rowLng: number | null | undefined,
  radiusMiles: number,
): { keep: boolean; distanceMiles: number | null } {
  if (!origin) return { keep: true, distanceMiles: null };
  if (
    rowLat == null ||
    rowLng == null ||
    !Number.isFinite(Number(rowLat)) ||
    !Number.isFinite(Number(rowLng))
  ) {
    return { keep: true, distanceMiles: null };
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
 * Reverse-geocode browser GPS to US city/state/zip (OpenStreetMap Nominatim).
 * Used to bias IRS ProPublica search when only lat/lng is available.
 *
 * Inputs: latitude, longitude.
 * Outputs: { city, state, zip } best-effort; null on failure.
 */
export async function reverseGeocodeUs(
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
      signal: AbortSignal.timeout(8000),
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
