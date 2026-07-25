"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usNonprofitSuggestRouter = void 0;
const express_1 = require("express");
const us_nonprofit_directory_1 = require("../lib/us-nonprofit-directory");
exports.usNonprofitSuggestRouter = (0, express_1.Router)();
exports.usNonprofitSuggestRouter.get("/nonprofits/us-suggest", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const state = typeof req.query.state === "string" ? req.query.state.trim() : "";
        const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
        const limit = Number.isFinite(limitRaw) ? limitRaw : 8;
        if (!q) {
            res.status(400).json({ error: "q is required" });
            return;
        }
        const result = await (0, us_nonprofit_directory_1.suggestUsNonprofits)({
            q,
            state: state || undefined,
            limit,
        });
        res.json({
            query: q,
            state: state || null,
            matchCount: result.candidates.length,
            totalResults: result.totalResults,
            provider: result.provider,
            candidates: result.candidates,
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to suggest US nonprofits" });
    }
});
exports.usNonprofitSuggestRouter.get("/nonprofits/us-enrich", async (req, res) => {
    try {
        const ein = typeof req.query.ein === "string" ? req.query.ein.trim() : "";
        if (!ein) {
            res.status(400).json({ error: "ein is required" });
            return;
        }
        const enriched = await (0, us_nonprofit_directory_1.enrichUsNonprofitByEin)(ein);
        if (!enriched) {
            res.status(404).json({ error: "No enrichment found for that EIN" });
            return;
        }
        res.json(enriched);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to enrich US nonprofit" });
    }
});
//# sourceMappingURL=us-nonprofit-suggest.js.map