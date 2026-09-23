/**
 * POST /api/business-venue-images
 *
 * Purpose: Return venue gallery photo URLs (Resy carousel + site JPGs) without
 * running the full AI business draft. Used by join profile to refresh stale
 * session drafts that only have a handful of site photos.
 *
 * Request: { websiteUrl: string, reservationUrl?: string | null }
 * Response: { imageUrls: string[], reservationUrl: string | null }
 */
import { Router } from "express";
import { scrapeBusinessVenueImages } from "../lib/business-venue-images";
import { scrapeBusinessLocationHints } from "../lib/business-website-location";

export const businessVenueImagesRouter = Router();

businessVenueImagesRouter.post("/business-venue-images", async (req, res) => {
  try {
    const websiteUrl =
      typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
    if (!websiteUrl) {
      res.status(400).json({ error: "websiteUrl is required." });
      return;
    }
    let reservationUrl =
      typeof req.body?.reservationUrl === "string"
        ? req.body.reservationUrl.trim()
        : "";
    if (!reservationUrl) {
      try {
        const hints = await scrapeBusinessLocationHints(websiteUrl);
        reservationUrl = hints.reservationUrl?.trim() || "";
      } catch {
        /* keep empty — scrape may still find booking link from homepage HTML */
      }
    }
    const imageUrls = await scrapeBusinessVenueImages({
      websiteUrl,
      reservationUrl: reservationUrl || null,
      limit: 16,
    });
    res.json({
      imageUrls,
      reservationUrl: reservationUrl || null,
    });
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to scrape venue images";
    res.status(500).json({ error: message });
  }
});
