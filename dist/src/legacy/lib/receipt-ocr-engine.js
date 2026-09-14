"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractReceiptOcr = extractReceiptOcr;
const bedrock_receipt_ocr_1 = require("./bedrock-receipt-ocr");
const ai_chat_1 = require("./ai-chat");
const mindee_ocr_1 = require("./mindee-ocr");
function providerSucceeded(result) {
    return Boolean(result.ocrProvider);
}
async function extractReceiptOcr(input) {
    const bedrockConfigured = (0, ai_chat_1.aiProviderName)() === "bedrock";
    const bedrock = await (0, bedrock_receipt_ocr_1.extractReceiptWithBedrock)(input);
    if (providerSucceeded(bedrock)) {
        return bedrock;
    }
    if (bedrockConfigured) {
        return bedrock;
    }
    const mindee = await (0, mindee_ocr_1.extractReceiptWithMindee)(input);
    if (providerSucceeded(mindee)) {
        return mindee;
    }
    return bedrock.ocrExtractStatus !== "failed" ? bedrock : mindee;
}
//# sourceMappingURL=receipt-ocr-engine.js.map