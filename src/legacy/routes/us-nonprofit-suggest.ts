import { Router } from "express";
import { enrichUsNonprofitByEin, suggestUsNonprofits } from "../lib/us-nonprofit-directory";

export const usNonprofitSuggestRouter = Router();

/**
 * GoFundMe-style US nonprofit typeahead (IRS via ProPublica + Every.org logos/websites).
 *
 * method: GET /api/profiles/nonprofits/us-suggest
 * query: { q: string, state?: string (2-letter), limit?: number }
 * response: {
 *   query, state, matchCount, totalResults, provider,
 *   candidates: UsNonprofitSuggestion[]
 * }
 *
 * Additive only — does not modify local /nonprofits/search.
 */
usNonprofitSuggestRouter.get("/nonprofits/us-suggest", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const state = typeof req.query.state === "string" ? req.query.state.trim() : "";
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 8;

    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }

    const result = await suggestUsNonprofits({
      q,
      state: state || undefined,
      limit,
    });

    res.json({
      query: q,
      state: state || null,
      matchCount: result.candidates.length,
      totalResults: result.totalResults,
      provider: result.provider,
      candidates: result.candidates,
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
