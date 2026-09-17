"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findBusinessProfileRouter = void 0;
const express_1 = require("express");
const find_business_from_name_1 = require("../lib/find-business-from-name");
exports.findBusinessProfileRouter = (0, express_1.Router)();
exports.findBusinessProfileRouter.post("/find-business-profile", async (req, res) => {
    try {
        const businessName = typeof req.body?.businessName === "string" ? req.body.businessName.trim() : "";
        if (!businessName) {
            res.status(400).json({ error: "Business name is required." });
            return;
        }
        const result = await (0, find_business_from_name_1.findBusinessFromName)({
            businessName,
            joinDoorType: req.body?.joinDoorType,
        });
        res.json(result);
    }
    catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Failed to find business profile";
        const status = message.toLowerCase().includes("rate")
            ? 429
            : message.toLowerCase().includes("no ai provider")
                ? 503
                : 500;
        res.status(status).json({ error: message });
    }
});
//# sourceMappingURL=find-business-profile.js.map