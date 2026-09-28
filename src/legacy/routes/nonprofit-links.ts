/**
 * POST /api/nonprofit-links
 *
 * Purpose: Persist user-edited social / contact / about for a nonprofit
 * they belong to. Overwrites provided fields; empty clears.
 *
 * Request: {
 *   nonprofitId: number,
 *   website?: string | null,
 *   facebookUrl?: string | null,
 *   instagramUrl?: string | null,
 *   linkedinUrl?: string | null,
 *   tiktokUrl?: string | null,
 *   youtubeUrl?: string | null,
 *   phone?: string | null,
 *   contactEmail?: string | null,
 *   about?: string | null,
 *   city?: string | null,
 *   state?: string | null,
 *   zip?: string | null,
 *   organizationName?: string | null
 * }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { userBelongsToNonprofit } from "../lib/campaign-partner-join-requests";
import {
  updateNonprofitPublicLinks,
  type NonprofitPublicLinksUpdate,
} from "../lib/persist-nonprofit-public-links";
import { pool } from "../db/pool";

export const nonprofitLinksRouter = Router();

function optionalString(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  return raw;
}

nonprofitLinksRouter.post("/nonprofit-links", async (req, res) => {
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

    const body = req.body ?? {};
    const patch: NonprofitPublicLinksUpdate = {};
    if (Object.prototype.hasOwnProperty.call(body, "website")) {
      patch.website = optionalString(body.website) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "facebookUrl")) {
      patch.facebookUrl = optionalString(body.facebookUrl) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "instagramUrl")) {
      patch.instagramUrl = optionalString(body.instagramUrl) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "linkedinUrl")) {
      patch.linkedinUrl = optionalString(body.linkedinUrl) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "tiktokUrl")) {
      patch.tiktokUrl = optionalString(body.tiktokUrl) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "youtubeUrl")) {
      patch.youtubeUrl = optionalString(body.youtubeUrl) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      patch.phone = optionalString(body.phone) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "contactEmail")) {
      patch.contactEmail = optionalString(body.contactEmail) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "about")) {
      patch.about = optionalString(body.about) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "city")) {
      patch.city = optionalString(body.city) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "state")) {
      patch.state = optionalString(body.state) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "zip")) {
      patch.zip = optionalString(body.zip) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "organizationName")) {
      patch.organizationName = optionalString(body.organizationName) ?? null;
    }

    if (Object.keys(patch).length === 0) {
      const { rows } = await pool.query<{
        website: string | null;
        facebook_url: string | null;
        instagram_url: string | null;
        linkedin_url: string | null;
        tiktok_url: string | null;
        youtube_url: string | null;
        contact_phone: string | null;
        contact_email: string | null;
        description: string | null;
        mission: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
        organization_name: string | null;
      }>(
        `SELECT website, facebook_url, instagram_url, linkedin_url, tiktok_url,
                youtube_url, contact_phone, contact_email, description, mission,
                city, state, zip, organization_name
         FROM nonprofits WHERE id = $1 LIMIT 1`,
        [nonprofitId],
      );
      const row = rows[0];
      const about =
        row?.description?.trim() || row?.mission?.trim() || null;
      res.json({
        website: row?.website?.trim() || null,
        facebookUrl: row?.facebook_url?.trim() || null,
        instagramUrl: row?.instagram_url?.trim() || null,
        linkedinUrl: row?.linkedin_url?.trim() || null,
        tiktokUrl: row?.tiktok_url?.trim() || null,
        youtubeUrl: row?.youtube_url?.trim() || null,
        phone: row?.contact_phone?.trim() || null,
        contactEmail: row?.contact_email?.trim() || null,
        about,
        city: row?.city?.trim() || null,
        state: row?.state?.trim() || null,
        zip: row?.zip?.trim() || null,
        organizationName: row?.organization_name?.trim() || null,
      });
      return;
    }

    const written = await updateNonprofitPublicLinks(nonprofitId, patch);
    if (written == null) {
      res.status(500).json({ error: "Failed to save organization links." });
      return;
    }

    res.json(written);
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to save organization links";
    res.status(500).json({ error: message });
  }
});
