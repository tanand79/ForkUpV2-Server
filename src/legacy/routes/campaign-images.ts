/**
 * Campaign gallery images API (additive).
 *
 * POST /api/campaign-images/suggest
 *   body: { facebookUrl?, instagramHandle?, websiteUrl?, linkedinUrl?, youtubeUrl?, limit? }
 *   response: { images: { url, source, sourceUrl, caption? }[] }
 *
 * GET /api/campaign-images/:slug
 *   response: { images: { id, imageUrl, source, sourceUrl, sortOrder, isCover }[] }
 *
 * PUT /api/campaign-images/:slug
 *   auth required (nonprofit member, creator, or platform admin)
 *   body: { images: { imageUrl, source?, sourceUrl?, isCover? }[] }  // max 6
 *   response: { images: ... }  (same shape as GET)
 */

import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { pool } from "../db/pool";
import { resolveStoredImageUrl } from "../lib/s3";
import {
  suggestSocialImages,
} from "../lib/suggest-social-images";

export const campaignImagesRouter = Router();

const MAX_GALLERY = 6;
const ALLOWED_SOURCES = new Set([
  "manual",
  "website",
  "facebook",
  "instagram",
  "library",
  "social_suggest",
]);

type ImageRow = QueryResultRow & {
  id: number;
  image_url: string;
  source: string;
  source_url: string | null;
  sort_order: number;
  is_cover: boolean;
};

async function mapImageRows(rows: ImageRow[]) {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      imageUrl: await resolveStoredImageUrl(row.image_url),
      storedUrl: row.image_url,
      source: row.source,
      sourceUrl: row.source_url,
      sortOrder: row.sort_order,
      isCover: Boolean(row.is_cover),
    })),
  );
}

async function userCanEditCampaign(
  userId: number,
  isPlatformAdmin: boolean,
  campaign: { nonprofit_id: number; created_by_user_id: number | null },
): Promise<boolean> {
  if (isPlatformAdmin) return true;
  if (campaign.created_by_user_id && Number(campaign.created_by_user_id) === userId) {
    return true;
  }
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT 1 FROM organization_users
     WHERE organization_type = 'nonprofit'
       AND organization_id = $1
       AND user_id = $2
     LIMIT 1`,
    [campaign.nonprofit_id, userId],
  );
  return rows.length > 0;
}

/**
 * POST /api/campaign-images/suggest
 * Suggest up to 10 public preview images from social / website handles.
 * Prefer public post images when social URLs are present.
 */
campaignImagesRouter.post("/suggest", async (req, res) => {
  try {
    const { facebookUrl, instagramHandle, websiteUrl, linkedinUrl, youtubeUrl, limit } =
      req.body as Record<string, unknown>;

    const requested =
      typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : MAX_GALLERY;
    const images = await suggestSocialImages({
      facebookUrl: typeof facebookUrl === "string" ? facebookUrl : "",
      instagramHandle: typeof instagramHandle === "string" ? instagramHandle : "",
      websiteUrl: typeof websiteUrl === "string" ? websiteUrl : "",
      linkedinUrl: typeof linkedinUrl === "string" ? linkedinUrl : "",
      youtubeUrl: typeof youtubeUrl === "string" ? youtubeUrl : "",
      limit: Math.min(10, Math.max(1, requested)),
    });

    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to suggest images" });
  }
});

/**
 * GET /api/campaign-images/:slug
 * Public gallery for a live/closed campaign (also returns for any slug that exists).
 */
campaignImagesRouter.get("/:slug", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, campaign_status FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaignId = Number(campaigns[0].id);
    const { rows } = await pool.query<ImageRow>(
      `SELECT id, image_url, source, source_url, sort_order, is_cover
       FROM campaign_images
       WHERE campaign_id = $1
       ORDER BY sort_order ASC, id ASC
       LIMIT $2`,
      [campaignId, MAX_GALLERY],
    );

    res.json({ images: await mapImageRows(rows) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaign images" });
  }
});

/**
 * PUT /api/campaign-images/:slug
 * Replace gallery (max 6). Auth required.
 */
campaignImagesRouter.put("/:slug", async (req, res) => {
  const connection = await pool.connect();
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      `SELECT id, nonprofit_id, created_by_user_id, campaign_status
       FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];
    const allowed = await userCanEditCampaign(
      authUser.id,
      authUser.isPlatformAdmin,
      {
        nonprofit_id: Number(campaign.nonprofit_id),
        created_by_user_id: campaign.created_by_user_id
          ? Number(campaign.created_by_user_id)
          : null,
      },
    );
    if (!allowed) {
      res.status(403).json({ error: "Not allowed to edit this campaign" });
      return;
    }

    const body = req.body as { images?: unknown };
    if (!Array.isArray(body.images)) {
      res.status(400).json({ error: "images array is required" });
      return;
    }
    if (body.images.length > MAX_GALLERY) {
      res.status(400).json({ error: `At most ${MAX_GALLERY} images are allowed` });
      return;
    }

    const normalized: {
      imageUrl: string;
      source: string;
      sourceUrl: string | null;
      isCover: boolean;
    }[] = [];

    for (const item of body.images) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const imageUrl =
        typeof row.imageUrl === "string"
          ? row.imageUrl.trim()
          : typeof row.url === "string"
            ? row.url.trim()
            : "";
      if (!imageUrl || imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")) {
        res.status(400).json({
          error: "Each image needs a durable imageUrl (not a blob: or data: URL)",
        });
        return;
      }
      if (imageUrl.length > 512) {
        res.status(400).json({ error: "imageUrl is too long" });
        return;
      }
      let source =
        typeof row.source === "string" && ALLOWED_SOURCES.has(row.source)
          ? row.source
          : "manual";
      // Remote social previews that weren't re-uploaded yet
      if (
        source === "manual" &&
        /^https?:\/\//i.test(imageUrl) &&
        !imageUrl.includes("/uploads/")
      ) {
        source = "social_suggest";
      }
      const sourceUrl =
        typeof row.sourceUrl === "string" && row.sourceUrl.trim()
          ? row.sourceUrl.trim().slice(0, 512)
          : null;
      normalized.push({
        imageUrl,
        source,
        sourceUrl,
        isCover: Boolean(row.isCover),
      });
    }

    // Ensure at most one cover; if none marked, first is cover.
    let coverIdx = normalized.findIndex((i) => i.isCover);
    if (coverIdx < 0 && normalized.length > 0) coverIdx = 0;
    normalized.forEach((i, idx) => {
      i.isCover = idx === coverIdx;
    });

    const campaignId = Number(campaign.id);

    await connection.query("BEGIN");
    await connection.query(`DELETE FROM campaign_images WHERE campaign_id = $1`, [
      campaignId,
    ]);

    for (let i = 0; i < normalized.length; i++) {
      const img = normalized[i]!;
      await connection.query(
        `INSERT INTO campaign_images (
           campaign_id, image_url, source, source_url, sort_order, is_cover
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [campaignId, img.imageUrl, img.source, img.sourceUrl, i, img.isCover],
      );
    }

    // Keep campaigns.cover_image_url in sync when a gallery cover is set.
    const cover = normalized.find((i) => i.isCover);
    if (cover) {
      await connection.query(
        `UPDATE campaigns SET cover_image_url = $1, updated_at = NOW() WHERE id = $2`,
        [cover.imageUrl, campaignId],
      );
    }

    await connection.query("COMMIT");

    const { rows } = await connection.query<ImageRow>(
      `SELECT id, image_url, source, source_url, sort_order, is_cover
       FROM campaign_images
       WHERE campaign_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [campaignId],
    );

    res.json({ images: await mapImageRows(rows) });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to save campaign images" });
  } finally {
    connection.release();
  }
});
