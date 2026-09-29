"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestNearbyBusinessesRouter = void 0;
const express_1 = require("express");
const suggest_nearby_businesses_1 = require("../lib/suggest-nearby-businesses");
exports.suggestNearbyBusinessesRouter = (0, express_1.Router)();
exports.suggestNearbyBusinessesRouter.post("/suggest-nearby-businesses", async (req, res) => {
    try {
        const nearZip = typeof req.body?.nearZip === "string"
            ? req.body.nearZip
            : typeof req.body?.zip === "string"
                ? req.body.zip
                : "";
        const result = await (0, suggest_nearby_businesses_1.suggestNearbyBusinesses)({
            nearZip,
            joinDoorType: req.body?.joinDoorType,
            city: req.body?.city,
            state: req.body?.state,
            limit: req.body?.limit,
        });
        res.json(result);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error
            ? err.message
            : "Failed to suggest nearby businesses";
        const status = message.toLowerCase().includes("zip is required") ||
            message.toLowerCase().includes("5-digit")
            ? 400
            : message.toLowerCase().includes("rate")
                ? 429
                : message.toLowerCase().includes("no ai provider")
                    ? 503
                    : 500;
        res.status(status).json({ error: message });
    }
});
//# sourceMappingURL=suggest-nearby-businesses.js.map