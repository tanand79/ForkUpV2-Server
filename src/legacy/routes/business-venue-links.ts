/**
 * POST /api/business-venue-links
 *
 * Purpose: Persist user-edited venue social / contact / about / hours / location
 * for a business they belong to. Overwrites provided fields; empty clears.
 *
 * Request: {
 *   businessId: number,
 *   website?: string | null,
 *   facebookUrl?: string | null,
 *   instagramUrl?: string | null,
 *   linkedinUrl?: string | null,
 *   tiktokUrl?: string | null,
 *   phone?: string | null,
 *   venueEmail?: string | null,
 *   description?: string | null,
 *   discountHours?: Record<string, string> | null,
 *   eligibleWindow?: string | null,
 *   address?: string | null,
 *   city?: string | null,
 *   state?: string | null,
 *   zip?: string | null
 * }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { userBelongsToBusiness } from "../lib/campaign-partner-join-requests";
import {
  updateBusinessPublicLinks,
  updatePrimaryBusinessLocationDetails,
  normalizeVenueDiscountHours,
  type BusinessPublicLinksUpdate,
} from "../lib/persist-business-public-links";
import { pool } from "../db/pool";

export const businessVenueLinksRouter = Router();

function optionalString(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  return raw;
}

businessVenueLinksRouter.post("/business-venue-links", async (req, res) => {
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

    const body = req.body ?? {};
    const patch: BusinessPublicLinksUpdate = {};
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
    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      patch.phone = optionalString(body.phone) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "venueEmail")) {
      patch.venueEmail = optionalString(body.venueEmail) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      patch.description = optionalString(body.description) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "discountHours")) {
      patch.discountHours =
        body.discountHours && typeof body.discountHours === "object"
          ? normalizeVenueDiscountHours(body.discountHours)
          : normalizeVenueDiscountHours(null);
    }
    if (Object.prototype.hasOwnProperty.call(body, "eligibleWindow")) {
      patch.eligibleWindow = optionalString(body.eligibleWindow) ?? null;
    }

    const locPatch: {
      address?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
      phone?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(body, "address")) {
      locPatch.address = optionalString(body.address) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "city")) {
      locPatch.city = optionalString(body.city) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "state")) {
      locPatch.state = optionalString(body.state) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "zip")) {
      locPatch.zip = optionalString(body.zip) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      locPatch.phone = optionalString(body.phone) ?? null;
    }

    const hasBizPatch = Object.keys(patch).length > 0;
    const hasLocPatch = Object.keys(locPatch).length > 0;

    if (!hasBizPatch && !hasLocPatch) {
      const { rows } = await pool.query<{
        website: string | null;
        facebook_url: string | null;
        instagram_url: string | null;
        linkedin_url: string | null;
        tiktok_url: string | null;
        contact_phone: string | null;
        venue_email: string | null;
        description: string | null;
        venue_discount_hours: unknown;
        venue_eligible_window: string | null;
      }>(
        `SELECT website, facebook_url, instagram_url, linkedin_url, tiktok_url,
                contact_phone, venue_email, description,
                venue_discount_hours, venue_eligible_window
         FROM businesses WHERE id = $1 LIMIT 1`,
        [businessId],
      );
      const row = rows[0];
      res.json({
        website: row?.website?.trim() || null,
        facebookUrl: row?.facebook_url?.trim() || null,
        instagramUrl: row?.instagram_url?.trim() || null,
        linkedinUrl: row?.linkedin_url?.trim() || null,
        tiktokUrl: row?.tiktok_url?.trim() || null,
        phone: row?.contact_phone?.trim() || null,
        venueEmail: row?.venue_email?.trim() || null,
        description: row?.description?.trim() || null,
        discountHours: normalizeVenueDiscountHours(row?.venue_discount_hours),
        eligibleWindow: row?.venue_eligible_window?.trim() || null,
      });
      return;
    }

    let written: BusinessPublicLinksUpdate = {};
    if (hasBizPatch) {
      const result = await updateBusinessPublicLinks(businessId, patch);
      if (result == null) {
        res.status(500).json({ error: "Failed to save venue links." });
        return;
      }
      written = result;
    }
    if (hasLocPatch) {
      await updatePrimaryBusinessLocationDetails(businessId, locPatch);
    }

    res.json({ ...written, ...locPatch });
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to save venue links";
    res.status(500).json({ error: message });
  }
});
