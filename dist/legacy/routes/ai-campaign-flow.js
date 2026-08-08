"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiCampaignFlowRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const organization_ai_campaign_flow_1 = require("../lib/organization-ai-campaign-flow");
exports.aiCampaignFlowRouter = (0, express_1.Router)();
function trimBodyString(value) {
    return typeof value === "string" ? value.trim() : "";
}
exports.aiCampaignFlowRouter.post("/analyze", async (req, res) => {
    try {
        const body = (req.body ?? {});
        const organizationName = trimBodyString(body.organizationName);
        if (!organizationName || organizationName.length > 255) {
            res.status(400).json({ error: "organizationName is required." });
            return;
        }
        const auth = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        const nonprofitIdRaw = body.nonprofitId;
        const nonprofitId = typeof nonprofitIdRaw === "number"
            ? nonprofitIdRaw
            : typeof nonprofitIdRaw === "string" && nonprofitIdRaw.trim()
                ? Number(nonprofitIdRaw)
                : null;
        const session = await (0, organization_ai_campaign_flow_1.runOrganizationAiCampaignFlow)({
            organizationName,
            ein: trimBodyString(body.ein) || null,
            nonprofitId: Number.isFinite(nonprofitId) ? nonprofitId : null,
            website: trimBodyString(body.website) || null,
            facebookUrl: trimBodyString(body.facebookUrl) || null,
            instagramUrl: trimBodyString(body.instagramUrl) || null,
            linkedinUrl: trimBodyString(body.linkedinUrl) || null,
            mission: trimBodyString(body.mission) || null,
            causeCategory: trimBodyString(body.causeCategory) || null,
            city: trimBodyString(body.city) || null,
            state: trimBodyString(body.state) || null,
            createdByUserId: auth?.id ?? null,
        });
        res.json(session);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Could not analyze organization for campaign ideas.";
        const status = /No AI provider configured/i.test(message) ? 503 : 400;
        res.status(status).json({ error: message });
    }
});
exports.aiCampaignFlowRouter.post("/resolve-sources", async (req, res) => {
    try {
        const body = (req.body ?? {});
        const organizationName = trimBodyString(body.organizationName);
        if (!organizationName || organizationName.length > 255) {
            res.status(400).json({ error: "organizationName is required." });
            return;
        }
        const nonprofitIdRaw = body.nonprofitId;
        const nonprofitId = typeof nonprofitIdRaw === "number"
            ? nonprofitIdRaw
            : typeof nonprofitIdRaw === "string" && nonprofitIdRaw.trim()
                ? Number(nonprofitIdRaw)
                : null;
        const sources = await (0, organization_ai_campaign_flow_1.resolveAnalysisSources)({
            organizationName,
            ein: trimBodyString(body.ein) || null,
            nonprofitId: Number.isFinite(nonprofitId) ? nonprofitId : null,
            website: trimBodyString(body.website) || null,
            facebookUrl: trimBodyString(body.facebookUrl) || null,
            instagramUrl: trimBodyString(body.instagramUrl) || null,
            linkedinUrl: trimBodyString(body.linkedinUrl) || null,
            mission: trimBodyString(body.mission) || null,
            causeCategory: trimBodyString(body.causeCategory) || null,
            city: trimBodyString(body.city) || null,
            state: trimBodyString(body.state) || null,
        });
        res.json(sources);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Could not resolve organization links.";
        res.status(400).json({ error: message });
    }
});
exports.aiCampaignFlowRouter.get("/sessions/:sessionToken", async (req, res) => {
    try {
        const sessionToken = trimBodyString(req.params.sessionToken);
        if (!sessionToken || sessionToken.length > 128) {
            res.status(400).json({ error: "sessionToken is required." });
            return;
        }
        const session = await (0, organization_ai_campaign_flow_1.getAnalysisSessionByToken)(sessionToken);
        if (!session) {
            res.status(404).json({ error: "Analysis session not found or expired." });
            return;
        }
        res.json(session);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to load analysis session." });
    }
});
//# sourceMappingURL=ai-campaign-flow.js.map