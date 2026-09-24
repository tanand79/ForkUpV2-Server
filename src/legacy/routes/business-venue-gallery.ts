/**
 * POST /api/business-venue-gallery
 *
 * Purpose: Persist user-uploaded venue photos + chosen cover for a business
 * they belong to. Appends to venue_gallery_urls; sets venue_cover_url.
 *
 * Request: { businessId: number, imageUrls?: string[], coverUrl?: string | null }
 * Response: { imageUrls: string[], coverUrl: string | null }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { userBelongsToBusiness } from "../lib/campaign-partner-join-requests";
import {
  mergeBusinessGalleryUrls,
  persistBusinessVenueCoverUrl,
} from "../lib/persist-business-public-links";
import { pool } from "../db/pool";

export const businessVenueGalleryRouter = Router();

function parseGalleryUrls(raw: unknown): string[] {
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

async function loadVenueMedia(businessId: number): Promise<{
  imageUrls: string[];
  coverUrl: string | null;
}> {
  const { rows } = await pool.query<{
    venue_gallery_urls: unknown;
    venue_cover_url: string | null;
  }>(
    `SELECT venue_gallery_urls, venue_cover_url FROM businesses WHERE id = $1 LIMIT 1`,
    [businessId],
  );
  return {
    imageUrls: parseGalleryUrls(rows[0]?.venue_gallery_urls),
    coverUrl: rows[0]?.venue_cover_url?.trim() || null,
  };
}

businessVenueGalleryRouter.post("/business-venue-gallery", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    const businessIdRaw = Number(req.body?.businessId);
    const businessId =
      Number.isFinite(businessIdRaw) && businessIdRaw > 0 ? businessIdRaw : null;
    if (!businessId) {
      res.status(400).json({ error: "businessId is required." });
      return;
    }

    if (!userBelongsToBusiness(user, businessId)) {
      res.status(403).json({ error: "Not authorized for this business." });
      return;
    }

    const imageUrlsRaw = req.body?.imageUrls;
    const imageUrls = Array.isArray(imageUrlsRaw)
      ? imageUrlsRaw.filter(
          (u): u is string => typeof u === "string" && u.trim().length > 0,
        )
      : [];

    const hasCoverField = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "coverUrl",
    );
    const coverRaw = req.body?.coverUrl;
    const coverInput =
      typeof coverRaw === "string"
        ? coverRaw.trim() || null
        : coverRaw === null
          ? null
          : undefined;

    if (imageUrls.length === 0 && !hasCoverField) {
      const current = await loadVenueMedia(businessId);
      res.json(current);
      return;
    }

    let merged =
      imageUrls.length > 0
        ? await mergeBusinessGalleryUrls(businessId, imageUrls)
        : (await loadVenueMedia(businessId)).imageUrls;

    let coverUrl: string | null = null;
    if (hasCoverField) {
      coverUrl = await persistBusinessVenueCoverUrl(
        businessId,
        coverInput ?? null,
      );
      if (coverUrl && !merged.includes(coverUrl)) {
        merged = await mergeBusinessGalleryUrls(businessId, [coverUrl]);
      }
    } else {
      coverUrl = (await loadVenueMedia(businessId)).coverUrl;
    }

    res.json({ imageUrls: merged, coverUrl });
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to save venue gallery";
    res.status(500).json({ error: message });
  }
});
