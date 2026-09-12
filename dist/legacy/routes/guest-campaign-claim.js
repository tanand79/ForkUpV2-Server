"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guestCampaignClaimRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const guest_campaign_claim_1 = require("../lib/guest-campaign-claim");
exports.guestCampaignClaimRouter = (0, express_1.Router)();
exports.guestCampaignClaimRouter.get("/:token", async (req, res) => {
    try {
        const token = String(req.params.token || "");
        const claim = await (0, guest_campaign_claim_1.lookupGuestClaimToken)(token);
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load claim link" });
    }
});
exports.guestCampaignClaimRouter.post("/:token", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Sign in required to claim this campaign" });
            return;
        }
        const token = String(req.params.token || "");
        const claim = await (0, guest_campaign_claim_1.lookupGuestClaimToken)(token);
        if (!claim) {
            res.status(404).json({ error: "Claim link not found" });
            return;
        }
        const authEmail = authUser.email.trim().toLowerCase();
        const guestEmail = claim.guestEmail.trim().toLowerCase();
        if (!guestEmail.includes("@") || authEmail !== guestEmail) {
            res.status(403).json({
                error: `Sign in with ${claim.guestEmail} to claim this campaign. You are signed in as ${authUser.email}.`,
            });
            return;
        }
        const result = await (0, guest_campaign_claim_1.claimGuestCampaignForUser)(authUser.id, claim);
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to claim campaign" });
    }
});
//# sourceMappingURL=guest-campaign-claim.js.map