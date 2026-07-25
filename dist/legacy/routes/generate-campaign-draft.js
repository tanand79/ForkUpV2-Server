"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCampaignDraftRouter = void 0;
const express_1 = require("express");
const organization_library_1 = require("../lib/organization-library");
const ai_chat_1 = require("../lib/ai-chat");
exports.generateCampaignDraftRouter = (0, express_1.Router)();
exports.generateCampaignDraftRouter.post("/generate-campaign-draft", async (req, res) => {
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
        const website = typeof body.website === "string" ? body.website.trim() : "";
        const goal = body.goal != null && String(body.goal).trim() !== "" ? String(body.goal).trim() : "";
        const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
        const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
        const methods = Array.isArray(body.methods)
            ? body.methods.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
            : [];
        let libraryContext = "";
        let suggestedImageUrl = null;
        let libraryPromotion = { facebookUrl: "", instagramHandle: "", websiteUrl: "" };
        const orgType = body.organizationType === "business" ? "business" : "nonprofit";
        const orgId = Number(body.organizationId);
        if (orgId) {
            const approved = await (0, organization_library_1.fetchApprovedLibraryItems)(orgType, orgId);
            libraryContext = (0, organization_library_1.buildLibraryContext)(approved);
            suggestedImageUrl = (0, organization_library_1.pickFeaturedImage)(approved);
            libraryPromotion = (0, organization_library_1.pickPromotionChannels)(approved);
        }
        const system = [
            "You are an expert nonprofit fundraising campaign writer for the ForkUp platform.",
            "Given a few short answers from a nonprofit organizer, prepare a campaign draft they will review and edit.",
            "Write in the organization's authentic voice. Be specific and truthful to what was shared — never invent facts, figures, names, dates, or results.",
            "Prioritize emotional connection, clarity, impact, and a clear reason to participate.",
            "Guidelines:",
            "- title: a compelling campaign title, max ~70 characters, no quotation marks.",
            "- story: 120-220 words, warm and concrete, explaining why the cause matters and how support helps. No generic clichés or invented statistics.",
            "- purpose: a single short sentence summarizing the campaign goal.",
            "- facebookUrl: public Facebook page URL if you know the real one for this org; otherwise empty string. Never invent.",
            "- instagramHandle: public Instagram handle like @orgname if you know the real one; otherwise empty string. Never invent.",
            "- websiteUrl: official organization website URL if known from context; otherwise empty string.",
            'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string, "facebookUrl": string, "instagramHandle": string, "websiteUrl": string}.',
            "Do not include markdown, code fences, preamble, or commentary.",
        ].join("\n");
        const userParts = [
            `What they're raising money for: ${purpose}`,
            organizationName ? `Organization: ${organizationName}` : "",
            mission ? `Mission: ${mission}` : "",
            causeCategory ? `Cause category: ${causeCategory}` : "",
            website ? `Organization website: ${website}` : "",
            goal ? `Fundraising goal: ${goal}` : "",
            startDate || endDate ? `Dates: ${startDate || "TBD"} to ${endDate || "TBD"}` : "",
            methods.length ? `Fundraising methods: ${methods.join(", ")}` : "",
            libraryContext,
        ].filter(Boolean);
        const raw = await (0, ai_chat_1.aiChat)({
            system,
            user: userParts.join("\n"),
            json: true,
            maxTokens: 2048,
            temperature: 0.4,
        });
        let draft = {};
        try {
            draft = (0, ai_chat_1.parseAiJson)(raw);
        }
        catch {
            draft = { story: raw };
        }
        const str = (v) => (typeof v === "string" ? v.trim() : "");
        res.json({
            title: str(draft.title),
            story: str(draft.story),
            purpose: str(draft.purpose),
            suggestedImageUrl,
            facebookUrl: libraryPromotion.facebookUrl || str(draft.facebookUrl),
            instagramHandle: libraryPromotion.instagramHandle || str(draft.instagramHandle),
            websiteUrl: libraryPromotion.websiteUrl || str(draft.websiteUrl) || website,
            provider: (0, ai_chat_1.aiProviderName)(),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Could not prepare the campaign draft.";
        res.status(400).json({ error: message });
    }
});
//# sourceMappingURL=generate-campaign-draft.js.map