/**
 * Guest nonprofit claim API.
 *
 * GET  /api/guest-nonprofit-claim/:token
 *   Response: { slug, organizationName, guestEmail, nonprofitId, expired, alreadyClaimed }
 *
 * POST /api/guest-nonprofit-claim/:token
 *   Auth required. Logged-in email must match guest_claim_email on the nonprofit.
 *   Links that user to the nonprofit + sets claimed_by_user_id.
 *   Response: { ok: true, slug, nonprofitId, organizationName } | { error }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  claimGuestNonprofitForUser,
  lookupGuestNonprofitClaimToken,
} from "../lib/guest-nonprofit-claim";

export const guestNonprofitClaimRouter = Router();

guestNonprofitClaimRouter.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const claim = await lookupGuestNonprofitClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    const expired = claim.expiresAt.getTime() < Date.now();
    res.json({
      slug: claim.slug,
      organizationName: claim.organizationName,
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

guestNonprofitClaimRouter.post("/:token", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required to claim this organization" });
      return;
    }
    const token = String(req.params.token || "");
    const claim = await lookupGuestNonprofitClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    const authEmail = authUser.email.trim().toLowerCase();
    const guestEmail = claim.guestEmail.trim().toLowerCase();
    if (!guestEmail.includes("@") || authEmail !== guestEmail) {
      res.status(403).json({
        error: `Sign in with ${claim.guestEmail} to claim this organization. You are signed in as ${authUser.email}.`,
      });
      return;
    }
    const result = await claimGuestNonprofitForUser(authUser.id, claim);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      ok: true,
      slug: claim.slug,
      nonprofitId: claim.nonprofitId,
      organizationName: claim.organizationName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to claim organization" });
  }
});
