"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserAiBedrockModel = getUserAiBedrockModel;
exports.setUserAiBedrockModel = setUserAiBedrockModel;
exports.resolveUserBedrockModelId = resolveUserBedrockModelId;
const pool_1 = require("../db/pool");
const platform_settings_1 = require("./platform-settings");
const bedrock_model_catalog_1 = require("./bedrock-model-catalog");
async function getUserAiBedrockModel(userId) {
    const { rows } = await pool_1.pool.query(`SELECT ai_bedrock_model FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const raw = rows[0]?.ai_bedrock_model;
    if (!raw?.trim())
        return null;
    return (0, bedrock_model_catalog_1.migrateBedrockModelId)(raw);
}
async function setUserAiBedrockModel(userId, modelId) {
    const next = (0, bedrock_model_catalog_1.migrateBedrockModelId)(modelId);
    if (!(0, bedrock_model_catalog_1.isAllowedBedrockModel)(next)) {
        throw new Error(`Unsupported Bedrock model: ${modelId}`);
    }
    await pool_1.pool.query(`UPDATE users SET ai_bedrock_model = $1, updated_at = NOW() WHERE id = $2`, [next, userId]);
    return next;
}
async function resolveUserBedrockModelId(input) {
    const requested = String(input.requestModelId ?? "").trim();
    if (requested && (0, bedrock_model_catalog_1.isAllowedBedrockModel)(requested)) {
        return (0, bedrock_model_catalog_1.migrateBedrockModelId)(requested);
    }
    const userId = Number(input.userId);
    if (userId > 0) {
        const userModel = await getUserAiBedrockModel(userId);
        if (userModel)
            return userModel;
    }
    const platformKey = input.platformSettingKey ?? "ai_model_id";
    try {
        const fromPlatform = await (0, platform_settings_1.getPlatformSetting)(platformKey);
        if (fromPlatform?.trim() && (0, bedrock_model_catalog_1.isAllowedBedrockModel)(fromPlatform.trim())) {
            return (0, bedrock_model_catalog_1.migrateBedrockModelId)(fromPlatform.trim());
        }
    }
    catch {
    }
    const envDefault = input.envDefault?.trim() ||
        process.env.BEDROCK_MODEL_ID?.trim() ||
        process.env.BEDROCK_RECEIPT_MODEL_ID?.trim() ||
        bedrock_model_catalog_1.DEFAULT_BEDROCK_MODEL_ID;
    return (0, bedrock_model_catalog_1.migrateBedrockModelId)(envDefault);
}
//# sourceMappingURL=user-ai-settings.js.map