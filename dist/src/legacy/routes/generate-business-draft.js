"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBusinessDraftRouter = void 0;
const express_1 = require("express");
const business_draft_from_website_1 = require("../lib/business-draft-from-website");
exports.generateBusinessDraftRouter = (0, express_1.Router)();
exports.generateBusinessDraftRouter.post("/generate-business-draft", async (req, res) => {
    try {
        const website = typeof req.body?.website === "string" ? req.body.website.trim() : "";
        if (!website) {
            res.status(400).json({ error: "Website URL is required." });
            return;
        }
        const nearZip = typeof req.body?.nearZip === "string" ? req.body.nearZip.trim() : undefined;
        const city = typeof req.body?.city === "string" ? req.body.city.trim() : undefined;
        const state = typeof req.body?.state === "string" ? req.body.state.trim() : undefined;
        const draft = await (0, business_draft_from_website_1.generateBusinessDraftFromWebsite)(website, {
            nearZip,
            city,
            state,
        });
        res.json(draft);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to generate business draft";
        const status = message.toLowerCase().includes("rate") ? 429 :
            message.toLowerCase().includes("no ai provider") ? 503 :
                500;
        res.status(status).json({ error: message });
    }
});
//# sourceMappingURL=generate-business-draft.js.map