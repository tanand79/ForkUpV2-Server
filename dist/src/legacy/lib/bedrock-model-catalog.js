"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECATED_BEDROCK_MODELS = exports.DEFAULT_BEDROCK_MODEL_ID = exports.BEDROCK_MODEL_CATALOG = void 0;
exports.isAllowedBedrockModel = isAllowedBedrockModel;
exports.migrateBedrockModelId = migrateBedrockModelId;
exports.BEDROCK_MODEL_CATALOG = [
    {
        id: "amazon.nova-micro-v1:0",
        label: "Nova Micro",
        vendor: "Amazon",
        tier: "Lite",
        blurb: "Fastest & lowest cost",
        inputPer1M: 0.035,
        outputPer1M: 0.14,
    },
    {
        id: "amazon.nova-lite-v1:0",
        label: "Nova Lite",
        vendor: "Amazon",
        tier: "Balanced",
        blurb: "Fast & balanced",
        inputPer1M: 0.06,
        outputPer1M: 0.24,
    },
    {
        id: "amazon.nova-pro-v1:0",
        label: "Nova Pro",
        vendor: "Amazon",
        tier: "Pro",
        blurb: "Deeper reasoning on Bedrock",
        inputPer1M: 0.8,
        outputPer1M: 3.2,
    },
    {
        id: "anthropic.claude-haiku-4-5-20251001-v1:0",
        label: "Claude Haiku 4.5",
        vendor: "Anthropic",
        tier: "Lite",
        blurb: "Fast Claude responses",
        inputPer1M: 1.0,
        outputPer1M: 5.0,
    },
    {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        label: "Claude Sonnet 4.5",
        vendor: "Anthropic",
        tier: "Balanced",
        blurb: "Balanced Claude reasoning",
        inputPer1M: 3.0,
        outputPer1M: 15.0,
    },
    {
        id: "anthropic.claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        vendor: "Anthropic",
        tier: "Pro",
        blurb: "Best extraction quality",
        inputPer1M: 3.0,
        outputPer1M: 15.0,
    },
];
exports.DEFAULT_BEDROCK_MODEL_ID = "amazon.nova-lite-v1:0";
exports.DEPRECATED_BEDROCK_MODELS = {
    "anthropic.claude-3-haiku-20240307-v1:0": "anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-3-5-haiku-20241022-v1:0": "anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-3-5-sonnet-20241022-v2:0": "anthropic.claude-sonnet-4-6",
    "anthropic.claude-3-5-sonnet-20240620-v1:0": "anthropic.claude-sonnet-4-6",
};
function isAllowedBedrockModel(id) {
    const trimmed = id.trim();
    return exports.BEDROCK_MODEL_CATALOG.some((m) => m.id === trimmed);
}
function migrateBedrockModelId(stored) {
    const trimmed = String(stored ?? "").trim();
    if (!trimmed)
        return exports.DEFAULT_BEDROCK_MODEL_ID;
    if (isAllowedBedrockModel(trimmed))
        return trimmed;
    const migrated = exports.DEPRECATED_BEDROCK_MODELS[trimmed];
    if (migrated && isAllowedBedrockModel(migrated))
        return migrated;
    return exports.DEFAULT_BEDROCK_MODEL_ID;
}
//# sourceMappingURL=bedrock-model-catalog.js.map