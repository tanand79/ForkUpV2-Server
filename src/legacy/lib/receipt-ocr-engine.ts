/**
 * Receipt OCR orchestrator — Bedrock vision first, Mindee fallback, then manual.
 *
 * Purpose: Single entry point for receipt upload OCR (replaces direct Mindee calls).
 * Inputs: image base64, mime type, optional claimed subtotal.
 * Outputs: MindeeOcrResult-compatible payload for receipts table columns.
 */
import { extractReceiptWithBedrock } from "./bedrock-receipt-ocr";
import { aiProviderName } from "./ai-chat";
import { extractReceiptWithMindee, type MindeeOcrResult } from "./mindee-ocr";

function providerSucceeded(result: MindeeOcrResult): boolean {
  return Boolean(result.ocrProvider);
}

/**
 * Prefer AWS Bedrock vision when configured; otherwise Mindee (if keyed); else manual review.
 * When Bedrock is configured, Mindee is not used — avoids silent fallback to Mindee on vision errors.
 */
export async function extractReceiptOcr(input: {
  imageBase64: string;
  mimeType: string;
  claimedSubtotal?: number | null;
  bedrockModelId?: string | null;
  userId?: number | null;
}): Promise<MindeeOcrResult> {
  const bedrockConfigured = aiProviderName() === "bedrock";
  const bedrock = await extractReceiptWithBedrock(input);
  if (providerSucceeded(bedrock)) {
    return bedrock;
  }

  if (bedrockConfigured) {
    return bedrock;
  }

  const mindee = await extractReceiptWithMindee(input);
  if (providerSucceeded(mindee)) {
    return mindee;
  }

  return bedrock.ocrExtractStatus !== "failed" ? bedrock : mindee;
}
