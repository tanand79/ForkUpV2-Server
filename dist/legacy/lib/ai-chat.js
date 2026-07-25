"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiProviderName = aiProviderName;
exports.aiChat = aiChat;
exports.parseAiJson = parseAiJson;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const platform_settings_1 = require("./platform-settings");
function bedrockConfigured() {
    return Boolean(process.env.AWS_ACCESS_KEY_ID?.trim() &&
        process.env.AWS_SECRET_ACCESS_KEY?.trim() &&
        (process.env.AWS_REGION?.trim() || "us-east-1"));
}
function lovableConfigured() {
    return Boolean(process.env.LOVABLE_API_KEY?.trim());
}
function aiProviderName() {
    if (bedrockConfigured())
        return "bedrock";
    if (lovableConfigured())
        return "lovable";
    return "none";
}
function bedrockModelId() {
    return (process.env.BEDROCK_MODEL_ID?.trim() ||
        "amazon.nova-lite-v1:0");
}
async function resolveBedrockModelId() {
    try {
        const fromDb = await (0, platform_settings_1.getPlatformSetting)("ai_model_id");
        if (fromDb?.trim())
            return fromDb.trim();
    }
    catch {
    }
    return bedrockModelId();
}
async function chatViaBedrock(options) {
    const region = process.env.AWS_REGION?.trim() || "us-east-1";
    const client = new client_bedrock_runtime_1.BedrockRuntimeClient({
        region,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
        },
    });
    const systemText = options.json
        ? `${options.system}\nReturn ONLY valid JSON. No markdown fences or commentary.`
        : options.system;
    const command = new client_bedrock_runtime_1.ConverseCommand({
        modelId: await resolveBedrockModelId(),
        system: [{ text: systemText }],
        messages: [
            {
                role: "user",
                content: [{ text: options.user }],
            },
        ],
        inferenceConfig: {
            maxTokens: options.maxTokens ?? 2048,
            temperature: options.temperature ?? 0.4,
        },
    });
    const response = await client.send(command);
    const parts = response.output?.message?.content ?? [];
    const text = parts
        .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim();
    if (!text) {
        throw new Error("Bedrock returned an empty response.");
    }
    return text;
}
async function chatViaLovable(options) {
    const apiKey = process.env.LOVABLE_API_KEY.trim();
    const system = options.json
        ? `${options.system}\nReturn ONLY valid JSON. No markdown fences or commentary.`
        : options.system;
    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": apiKey,
        },
        body: JSON.stringify({
            model: "google/gemini-3-flash-preview",
            ...(options.json ? { response_format: { type: "json_object" } } : {}),
            messages: [
                { role: "system", content: system },
                { role: "user", content: options.user },
            ],
        }),
    });
    if (upstream.status === 429)
        throw new Error("Rate limited. Please try again in a moment.");
    if (upstream.status === 402)
        throw new Error("AI credits exhausted. Please add credits to continue.");
    if (!upstream.ok)
        throw new Error("AI request failed. Please try again.");
    const json = (await upstream.json());
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content)
        throw new Error("AI returned an empty response.");
    return content;
}
async function aiChat(options) {
    if (bedrockConfigured()) {
        return chatViaBedrock(options);
    }
    if (lovableConfigured()) {
        return chatViaLovable(options);
    }
    throw new Error("No AI provider configured. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION (Bedrock) or LOVABLE_API_KEY.");
}
function parseAiJson(raw) {
    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    return JSON.parse(cleaned);
}
//# sourceMappingURL=ai-chat.js.map