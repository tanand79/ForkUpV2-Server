/**
 * Guest business claim API.
 *
 * GET  /api/guest-business-claim/:token
 *   Response: { slug, businessName, guestEmail, expired, alreadyClaimed }
 *
 * POST /api/guest-business-claim/:token
 *   Auth required. Logged-in email must match guest_claim_email on the business.
 *   Links that user to the business + sets claimed_by_user_id.
 *   Response: { ok: true, slug, businessId, businessName } | { error }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  claimGuestBusinessForUser,
  lookupGuestBusinessClaimToken,
} from "../lib/guest-business-claim";

export const guestBusinessClaimRouter = Router();

guestBusinessClaimRouter.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const claim = await lookupGuestBusinessClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    const expired = claim.expiresAt.getTime() < Date.now();
    res.json({
      slug: claim.slug,
      businessName: claim.businessName,
      guestEmail: claim.guestEmail,
      businessId: claim.businessId,
      expired,
      alreadyClaimed: Boolean(claim.claimedAt),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load claim link" });
  }
});

guestBusinessClaimRouter.post("/:token", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required to claim this business" });
      return;
    }
    const token = String(req.params.token || "");
    const claim = await lookupGuestBusinessClaimToken(token);
    if (!claim) {
      res.status(404).json({ error: "Claim link not found" });
      return;
    }
    const authEmail = authUser.email.trim().toLowerCase();
    const guestEmail = claim.guestEmail.trim().toLowerCase();
    if (!guestEmail.includes("@") || authEmail !== guestEmail) {
      res.status(403).json({
        error: `Sign in with ${claim.guestEmail} to claim this business. You are signed in as ${authUser.email}.`,
      });
      return;
    }
    const result = await claimGuestBusinessForUser(authUser.id, claim);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      ok: true,
      slug: claim.slug,
      businessId: claim.businessId,
      businessName: claim.businessName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to claim business" });
  }
});
