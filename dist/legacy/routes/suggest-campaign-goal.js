"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestCampaignGoalRouter = void 0;
const express_1 = require("express");
const ai_chat_1 = require("../lib/ai-chat");
exports.suggestCampaignGoalRouter = (0, express_1.Router)();
function parseSuggestedGoal(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.round(value);
    }
    if (typeof value === "string") {
        const digits = value.replace(/[^0-9.]/g, "");
        if (!digits)
            return null;
        const n = Number.parseFloat(digits);
        if (!Number.isFinite(n) || n <= 0)
            return null;
        return Math.round(n);
    }
    return null;
}
exports.suggestCampaignGoalRouter.post("/suggest-campaign-goal", async (req, res) => {
    try {
        const body = (req.body ?? {});
        const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
        if (!purpose || purpose.length > 2000) {
            res.status(400).json({ error: "Tell us what you're raising money for." });
            return;
        }
        if ((0, ai_chat_1.aiProviderName)() === "none") {
            res.status(503).json({
                error: "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
            });
            return;
        }
        const organizationName = typeof body.organizationName === "string" ? body.organizationName.trim() : "";
        const mission = typeof body.mission === "string" ? body.mission.trim() : "";
        const causeCategory = typeof body.causeCategory === "string" ? body.causeCategory.trim() : "";
        const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
        const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
        const system = [
            "You are an expert nonprofit fundraising advisor for the ForkUp platform.",
            "Suggest one realistic whole-dollar USD fundraising goal for a community campaign.",
            "This is a recommendation the organizer can edit — not a claimed past result.",
            "Typical community campaigns: 2500–25000. Prefer round amounts (e.g. 5000, 10000).",
            "Return ONLY valid minified JSON: {\"suggestedGoal\": number}.",
            "Do not include markdown, code fences, preamble, or commentary.",
        ].join("\n");
        const userParts = [
            `What they're raising money for: ${purpose}`,
            organizationName ? `Organization: ${organizationName}` : "",
            mission ? `Mission: ${mission}` : "",
            causeCategory ? `Cause category: ${causeCategory}` : "",
            startDate || endDate ? `Dates: ${startDate || "TBD"} to ${endDate || "TBD"}` : "",
        ].filter(Boolean);
        const raw = await (0, ai_chat_1.aiChat)({
            system,
            user: userParts.join("\n"),
            json: true,
            maxTokens: 256,
            temperature: 0.4,
        });
        let draft = {};
        try {
            draft = (0, ai_chat_1.parseAiJson)(raw);
        }
        catch {
            draft = {};
        }
        const suggestedGoal = parseSuggestedGoal(draft.suggestedGoal);
        if (suggestedGoal == null) {
            res.status(400).json({ error: "Could not suggest a fundraising goal." });
            return;
        }
        res.json({
            suggestedGoal,
            provider: (0, ai_chat_1.aiProviderName)(),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Could not suggest a fundraising goal.";
        res.status(400).json({ error: message });
    }
});
//# sourceMappingURL=suggest-campaign-goal.js.map