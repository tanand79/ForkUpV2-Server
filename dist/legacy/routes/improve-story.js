"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.improveStoryRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const ai_chat_1 = require("../lib/ai-chat");
exports.improveStoryRouter = (0, express_1.Router)();
exports.improveStoryRouter.post("/improve-story", async (req, res) => {
    try {
        const story = typeof req.body?.story === "string" ? req.body.story.trim() : "";
        if (!story || story.length > 5000) {
            res.status(400).json({ error: "Invalid story text." });
            return;
        }
        if ((0, ai_chat_1.aiProviderName)() === "none") {
            res.status(503).json({
                error: "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
            });
            return;
        }
        const system = [
            "You are an expert storytelling editor for nonprofit fundraising campaigns.",
            "Your job is not simply to rewrite text. Strengthen the story so readers understand why the cause matters, what their support accomplishes, and why they should get involved.",
            "When improving, prioritize in this order:",
            "1. Emotional connection",
            "2. Clarity",
            "3. Impact",
            "4. Community involvement",
            "5. Supporter motivation",
            "Help the nonprofit move beyond describing what they do, and instead explain why people should care and how their participation makes a difference.",
            "Rules:",
            "- Correct spelling and grammar.",
            "- Improve sentence structure, readability, and flow.",
            "- Remove repetition and repeated phrases.",
            "- Preserve the user's original meaning and specific details.",
            "- Add genuine emotion and a clear sense of impact, but stay truthful to what was shared.",
            "- Do NOT add generic fundraising clichés or boilerplate calls to action.",
            "- Do NOT simply append extra paragraphs of generic language.",
            "- Keep it roughly the same length as the original.",
            "Return ONLY the improved story text, with no preamble, quotes, or commentary.",
        ].join("\n");
        const improved = await (0, ai_chat_1.aiChat)({
            system,
            user: story,
            maxTokens: 2048,
            temperature: 0.4,
            modelId: typeof req.body?.modelId === "string" ? req.body.modelId : undefined,
            userId: (await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req)))?.id ?? null,
        });
        res.json({ improved, provider: (0, ai_chat_1.aiProviderName)() });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Could not improve the story.";
        res.status(400).json({ error: message });
    }
});
//# sourceMappingURL=improve-story.js.map