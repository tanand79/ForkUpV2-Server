"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const bedrock_model_catalog_1 = require("../lib/bedrock-model-catalog");
const platform_settings_1 = require("../lib/platform-settings");
const user_ai_settings_1 = require("../lib/user-ai-settings");
exports.aiRouter = (0, express_1.Router)();
exports.aiRouter.get("/models", (_req, res) => {
    res.json({ models: bedrock_model_catalog_1.BEDROCK_MODEL_CATALOG });
});
exports.aiRouter.get("/settings", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        const platformDefault = (0, bedrock_model_catalog_1.migrateBedrockModelId)((await (0, platform_settings_1.getPlatformSetting)("ai_model_id")) ||
            process.env.BEDROCK_MODEL_ID?.trim() ||
            undefined);
        if (!user) {
            res.json({ modelId: platformDefault });
            return;
        }
        const userModel = await (0, user_ai_settings_1.getUserAiBedrockModel)(user.id);
        res.json({ modelId: userModel ?? platformDefault });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load AI settings" });
    }
});
exports.aiRouter.put("/settings", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in to save your AI engine preference" });
            return;
        }
        const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
        if (!modelId) {
            res.status(400).json({ error: "modelId is required" });
            return;
        }
        const saved = await (0, user_ai_settings_1.setUserAiBedrockModel)(user.id, modelId);
        res.json({ modelId: saved });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save AI settings";
        res.status(400).json({ error: message });
    }
});
//# sourceMappingURL=ai.js.map