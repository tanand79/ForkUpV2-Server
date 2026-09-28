"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nonprofitOrgProfileRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const hydrate_nonprofit_org_profile_1 = require("../lib/hydrate-nonprofit-org-profile");
exports.nonprofitOrgProfileRouter = (0, express_1.Router)();
exports.nonprofitOrgProfileRouter.get("/nonprofit-org-profile", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in required." });
            return;
        }
        const nonprofitIdRaw = Number(req.query?.nonprofitId);
        const nonprofitId = Number.isFinite(nonprofitIdRaw) && nonprofitIdRaw > 0
            ? nonprofitIdRaw
            : null;
        if (!nonprofitId) {
            res.status(400).json({ error: "nonprofitId is required." });
            return;
        }
        if (!(0, campaign_partner_join_requests_1.userBelongsToNonprofit)(user, nonprofitId)) {
            res.status(403).json({ error: "Not authorized for this organization." });
            return;
        }
        const profile = await (0, hydrate_nonprofit_org_profile_1.loadAndHydrateNonprofitOrgProfile)(nonprofitId);
        if (!profile) {
            res.status(404).json({ error: "Nonprofit not found." });
            return;
        }
        res.json(profile);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to load organization profile";
        if (/gallery_urls|cover_url/i.test(message)) {
            res.status(500).json({
                error: "Organization gallery columns are not ready yet. Run db:nonprofit-gallery.",
            });
            return;
        }
        res.status(500).json({ error: message });
    }
});
//# sourceMappingURL=nonprofit-org-profile.js.map