/**
 * Guest campaign claim API (Pass 2).
 *
 * GET  /api/guest-campaign-claim/:token
 *   Response: { slug, campaignName, guestEmail, expired, alreadyClaimed }
 *
 * POST /api/guest-campaign-claim/:token
 *   Auth required. Logged-in email must match guest_claim_email on the campaign.
 *   Links that user to nonprofit + sets created_by_user_id.
 *   Response: { ok: true, slug, nonprofitId } | { error }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  claimGuestCampaignForUser,
  lookupGuestClaimToken,
} from "../lib/guest-campaign-claim";

export const guestCampaignClaimRouter = Router();

guestCampaignClaimRouter.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const claim = await lookupGuestClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    const expired = claim.expiresAt.getTime() < Date.now();
    res.json({
      slug: claim.slug,
      campaignName: claim.campaignName,
      guestEmail: claim.guestEmail,
      nonprofitId: claim.nonprofitId,
      expired,
      alreadyClaimed: Boolean(claim.claimedAt),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load claim link" });
  }
});

guestCampaignClaimRouter.post("/:token", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required to claim this campaign" });
      return;
    }
    const token = String(req.params.token || "");
    const claim = await lookupGuestClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    // Claim token was emailed to guestEmail — only that account may attach.
    const authEmail = authUser.email.trim().toLowerCase();
    const guestEmail = claim.guestEmail.trim().toLowerCase();
    if (!guestEmail.includes("@") || authEmail !== guestEmail) {
      res.status(403).json({
        error: `Sign in with ${claim.guestEmail} to claim this campaign. You are signed in as ${authUser.email}.`,
      });
      return;
    }
    const result = await claimGuestCampaignForUser(authUser.id, claim);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      ok: true,
      slug: claim.slug,
      nonprofitId: claim.nonprofitId,
      campaignName: claim.campaignName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to claim campaign" });
  }
});
