/**
 * POST /api/business-venue-images
 *
 * Purpose: Return venue gallery photo URLs (Resy carousel + site JPGs) without
 * running the full AI business draft. Used by join profile to refresh stale
 * session drafts that only have a handful of site photos.
 *
 * Request: { websiteUrl: string, reservationUrl?: string | null, businessId?: number }
 * Response: { imageUrls: string[], reservationUrl: string | null, coverUrl?: string | null }
 *
 * Changelog: Do not call scrapeBusinessLocationHints here — that multi-page crawl
 * blocked the gallery spinner for tens of seconds. Booking links are taken from
 * the request or discovered inside scrapeBusinessVenueImages from homepage HTML.
 * Additive: optional businessId persists gallery URLs (null-only) for fast reopen.
 * Additive: when businessId already has venue_gallery_urls, return DB cache — no scrape.
 * Additive: cached path also returns businesses.venue_cover_url as coverUrl.
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { scrapeBusinessVenueImages } from "../lib/business-venue-images";
import { persistBusinessGalleryUrls } from "../lib/persist-business-public-links";

export const businessVenueImagesRouter = Router();

function parseStoredGallery(raw: unknown): string[] {
  if (!raw) return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0,
  );
}

businessVenueImagesRouter.post("/business-venue-images", async (req, res) => {
  try {
    const websiteUrl =
      typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
    if (!websiteUrl) {
      res.status(400).json({ error: "websiteUrl is required." });
      return;
    }
    const reservationUrl =
      typeof req.body?.reservationUrl === "string"
        ? req.body.reservationUrl.trim()
        : "";
    const businessIdRaw = Number(req.body?.businessId);
    const businessId =
      Number.isFinite(businessIdRaw) && businessIdRaw > 0 ? businessIdRaw : null;

    // Instant path: gallery already stored — never re-scrape on every open.
    if (businessId) {
      try {
        const { rows } = await pool.query<{
          venue_gallery_urls: unknown;
          venue_cover_url: string | null;
        }>(
          `SELECT venue_gallery_urls, venue_cover_url FROM businesses WHERE id = $1 LIMIT 1`,
          [businessId],
        );
        const cached = parseStoredGallery(rows[0]?.venue_gallery_urls);
        if (cached.length > 0) {
          const coverUrl = rows[0]?.venue_cover_url?.trim() || null;
          res.json({
            imageUrls: cached,
            reservationUrl: reservationUrl || null,
            coverUrl,
          });
          return;
        }
      } catch {
        /* fall through to scrape */
      }
    }

    const imageUrls = await scrapeBusinessVenueImages({
      websiteUrl,
      reservationUrl: reservationUrl || null,
      limit: 16,
    });

    if (businessId && imageUrls.length > 0) {
      void persistBusinessGalleryUrls(businessId, imageUrls);
    }

    res.json({
      imageUrls,
      reservationUrl: reservationUrl || null,
      coverUrl: null,
    });
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to scrape venue images";
    res.status(500).json({ error: message });
  }
});
