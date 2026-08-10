import { Router } from "express";
import { enrichUsNonprofitByEin, suggestUsNonprofits } from "../lib/us-nonprofit-directory";
import {
  geocodeUsCityState,
  geocodeUsZip,
  milesBetween,
  parseLatLng,
  parseRadiusMiles,
  reverseGeocodeUs,
  type LatLng,
} from "../lib/geo-distance";

export const usNonprofitSuggestRouter = Router();

type SuggestCandidate = Awaited<
  ReturnType<typeof suggestUsNonprofits>
>["candidates"][number] & {
  distanceMiles?: number | null;
  latitude?: number | null;
  longitude?: number | null;
};

function normCity(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function cityKey(city: string, state: string): string {
  return `city:${normCity(city)}|${state.trim().toUpperCase()}`;
}

/**
 * Prefetch unique city/ZIP coordinates in parallel (capped) so nearby filter
 * stays under the Next.js proxy timeout.
 */
async function prefetchCoords(
  keys: Array<{ key: string; kind: "zip" | "city"; zip?: string; city?: string; state?: string }>,
  cache: Map<string, LatLng | null>,
): Promise<void> {
  const unique = keys.filter((k) => !cache.has(k.key));
  const concurrency = 4;
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        if (item.kind === "zip" && item.zip) {
          cache.set(item.key, await geocodeUsZip(item.zip));
          return;
        }
        if (item.kind === "city" && item.city && item.state) {
          cache.set(item.key, await geocodeUsCityState(item.city, item.state));
        }
      }),
    );
  }
}

/**
 * Keep IRS candidates within radiusMiles of origin.
 * Fast path: same city as reverse-geocode uses one city geocode.
 * Remaining rows: ZIP/city geocode (parallel, cached).
 */
async function filterIrsCandidatesByNearby(
  candidates: SuggestCandidate[],
  origin: LatLng,
  radiusMiles: number,
  resultLimit: number,
  preferredCity: string | null,
  preferredState: string | null,
): Promise<SuggestCandidate[]> {
  const cache = new Map<string, LatLng | null>();
  const preferredCityNorm = normCity(preferredCity);
  const preferredStateNorm = (preferredState ?? "").trim().toUpperCase();

  const kept: SuggestCandidate[] = [];
  const needGeo: SuggestCandidate[] = [];

  for (const candidate of candidates) {
    const cCity = normCity(candidate.city);
    const cState = (candidate.state ?? "").trim().toUpperCase();
    // Same city as the user's pin → keep without external geocode (avoids Nominatim outages).
    if (
      preferredCityNorm &&
      preferredStateNorm &&
      cCity &&
      cCity === preferredCityNorm &&
      cState === preferredStateNorm
    ) {
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

  // Optional: one city-centroid for preferred place (distance labels for non-exact rows).
  if (preferredCityNorm && preferredStateNorm) {
    const key = cityKey(preferredCityNorm, preferredStateNorm);
    if (!cache.has(key)) {
      cache.set(
        key,
        await geocodeUsCityState(preferredCity ?? "", preferredState ?? ""),
      );
    }
  }

  const fetchKeys: Array<{
    key: string;
    kind: "zip" | "city";
    zip?: string;
    city?: string;
    state?: string;
  }> = [];
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
    let coords: LatLng | null = null;
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
    if (!coords) continue;

    const distanceMiles = milesBetween(
      origin.latitude,
      origin.longitude,
      coords.latitude,
      coords.longitude,
    );
    if (distanceMiles > radiusMiles) continue;

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

/**
 * GoFundMe-style US nonprofit typeahead (IRS via ProPublica + Every.org logos/websites).
 *
 * method: GET /api/profiles/nonprofits/us-suggest
 * query: {
 *   q: string,
 *   state?: string (2-letter),
 *   limit?: number,
 *   lat?: number,
 *   lng?: number,
 *   radiusMiles?: number (default 8; used when lat+lng present)
 * }
 *
 * When lat+lng are provided:
 * - reverse-geocodes to US city/state
 * - STRICT nearby filter (ZIP or city centroid within radiusMiles)
 * - Same-city matches are fast-pathed to avoid Next.js proxy timeouts
 */
usNonprofitSuggestRouter.get("/nonprofits/us-suggest", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    let state = typeof req.query.state === "string" ? req.query.state.trim() : "";
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 8;
    const origin = parseLatLng(req.query.lat, req.query.lng);
    const radiusMiles = parseRadiusMiles(req.query.radiusMiles);
    let derivedState: string | null = null;
    let derivedCity: string | null = null;

    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }

    if (origin) {
      const cityParam =
        typeof req.query.city === "string" ? req.query.city.trim() : "";
      if (cityParam) derivedCity = cityParam;

      if (!state || !derivedCity) {
        const geo = await reverseGeocodeUs(origin.latitude, origin.longitude);
        if (!state && geo?.state) {
          state = geo.state;
          derivedState = geo.state;
        } else if (state) {
          derivedState = state.toUpperCase();
        }
        if (!derivedCity && geo?.city) derivedCity = geo.city;
      } else {
        derivedState = state.toUpperCase();
      }
    }

    // Pull a wider IRS page when GPS filtering will discard far cities.
    const fetchLimit = origin ? Math.min(25, Math.max(limit * 3, 20)) : limit;

    const result = await suggestUsNonprofits({
      q,
      state: state || undefined,
      limit: fetchLimit,
    });

    let candidates: SuggestCandidate[] = result.candidates;
    if (origin) {
      candidates = await filterIrsCandidatesByNearby(
        candidates,
        origin,
        radiusMiles,
        limit,
        derivedCity,
        derivedState || state || null,
      );
    } else {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to suggest US nonprofits" });
  }
});

/**
 * Enrich a US directory pick for the confirm form (website, logo, ZIP, mission).
 *
 * method: GET /api/profiles/nonprofits/us-enrich
 * query: { ein: string, name?: string, city?: string, state?: string }
 * response: UsNonprofitEnrichment
 */
usNonprofitSuggestRouter.get("/nonprofits/us-enrich", async (req, res) => {
  try {
    const ein = typeof req.query.ein === "string" ? req.query.ein.trim() : "";
    if (!ein) {
      res.status(400).json({ error: "ein is required" });
      return;
    }

    const organizationName =
      typeof req.query.name === "string" ? req.query.name.trim() : "";
    const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
    const state = typeof req.query.state === "string" ? req.query.state.trim() : "";

    const enriched = await enrichUsNonprofitByEin(ein, {
      organizationName: organizationName || undefined,
      city: city || undefined,
      state: state || undefined,
    });
    if (!enriched) {
      res.status(404).json({ error: "No enrichment found for that EIN" });
      return;
    }
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to enrich US nonprofit" });
  }
});
