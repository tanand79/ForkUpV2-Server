/**
 * POST /api/nonprofit-gallery
 *
 * Purpose: Persist user-uploaded org photos + chosen cover for a nonprofit
 * they belong to. Appends to gallery_urls; sets cover_url.
 *
 * Request: { nonprofitId: number, imageUrls?: string[], coverUrl?: string | null }
 * Response: { imageUrls: string[], coverUrl: string | null }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { userBelongsToNonprofit } from "../lib/campaign-partner-join-requests";
import {
  mergeNonprofitGalleryUrls,
  parseNonprofitGalleryUrls,
  persistNonprofitCoverUrl,
} from "../lib/persist-nonprofit-public-links";
import { pool } from "../db/pool";

export const nonprofitGalleryRouter = Router();

async function loadOrgMedia(nonprofitId: number): Promise<{
  imageUrls: string[];
  coverUrl: string | null;
}> {
  const { rows } = await pool.query<{
    gallery_urls: unknown;
    cover_url: string | null;
  }>(
    `SELECT gallery_urls, cover_url FROM nonprofits WHERE id = $1 LIMIT 1`,
    [nonprofitId],
  );
  return {
    imageUrls: parseNonprofitGalleryUrls(rows[0]?.gallery_urls),
    coverUrl: rows[0]?.cover_url?.trim() || null,
  };
}

nonprofitGalleryRouter.post("/nonprofit-gallery", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    const nonprofitIdRaw = Number(req.body?.nonprofitId);
    const nonprofitId =
      Number.isFinite(nonprofitIdRaw) && nonprofitIdRaw > 0
        ? nonprofitIdRaw
        : null;
    if (!nonprofitId) {
      res.status(400).json({ error: "nonprofitId is required." });
      return;
    }

    if (!userBelongsToNonprofit(user, nonprofitId)) {
      res.status(403).json({ error: "Not authorized for this organization." });
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
      const current = await loadOrgMedia(nonprofitId);
      res.json(current);
      return;
    }

    let merged =
      imageUrls.length > 0
        ? await mergeNonprofitGalleryUrls(nonprofitId, imageUrls)
        : (await loadOrgMedia(nonprofitId)).imageUrls;

    let coverUrl: string | null = null;
    if (hasCoverField) {
      coverUrl = await persistNonprofitCoverUrl(
        nonprofitId,
        coverInput ?? null,
      );
      if (coverUrl && !merged.includes(coverUrl)) {
        merged = await mergeNonprofitGalleryUrls(nonprofitId, [coverUrl]);
      }
    } else {
      coverUrl = (await loadOrgMedia(nonprofitId)).coverUrl;
    }

    res.json({ imageUrls: merged, coverUrl });
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to save organization gallery";
    res.status(500).json({ error: message });
  }
});
