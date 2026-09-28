/**
 * GET /api/nonprofit-org-profile?nonprofitId=
 *
 * Purpose: Load org profile fields for the venue-style NPO profile screen
 * (about, social, gallery, location). Auth + membership required.
 *
 * When website/social/location/gallery are empty, hydrates from prior Create
 * Campaign AI analysis and/or the same live discovery path — then null-only
 * persists onto nonprofits so reopen is instant.
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { userBelongsToNonprofit } from "../lib/campaign-partner-join-requests";
import { loadAndHydrateNonprofitOrgProfile } from "../lib/hydrate-nonprofit-org-profile";

export const nonprofitOrgProfileRouter = Router();

nonprofitOrgProfileRouter.get("/nonprofit-org-profile", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    const nonprofitIdRaw = Number(req.query?.nonprofitId);
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

    const profile = await loadAndHydrateNonprofitOrgProfile(nonprofitId);
    if (!profile) {
      res.status(404).json({ error: "Nonprofit not found." });
      return;
    }

    res.json(profile);
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "Failed to load organization profile";
    if (/gallery_urls|cover_url/i.test(message)) {
      res.status(500).json({
        error:
          "Organization gallery columns are not ready yet. Run db:nonprofit-gallery.",
      });
      return;
    }
    res.status(500).json({ error: message });
  }
});
