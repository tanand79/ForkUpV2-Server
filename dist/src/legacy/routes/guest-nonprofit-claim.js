"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guestNonprofitClaimRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const guest_nonprofit_claim_1 = require("../lib/guest-nonprofit-claim");
exports.guestNonprofitClaimRouter = (0, express_1.Router)();
exports.guestNonprofitClaimRouter.get("/:token", async (req, res) => {
    try {
        const token = String(req.params.token || "");
        const claim = await (0, guest_nonprofit_claim_1.lookupGuestNonprofitClaimToken)(token);
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load claim link" });
    }
});
exports.guestNonprofitClaimRouter.post("/:token", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Sign in required to claim this organization" });
            return;
        }
        const token = String(req.params.token || "");
        const claim = await (0, guest_nonprofit_claim_1.lookupGuestNonprofitClaimToken)(token);
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
        const result = await (0, guest_nonprofit_claim_1.claimGuestNonprofitForUser)(authUser.id, claim);
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to claim organization" });
    }
});
//# sourceMappingURL=guest-nonprofit-claim.js.map