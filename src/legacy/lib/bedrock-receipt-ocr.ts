/**
 * Receipt / check / invoice OCR via AWS Bedrock vision (Converse multimodal).
 *
 * Purpose: Replace Mindee as the primary receipt reader when AWS Bedrock is configured.
 * Inputs: base64 image (+ mime), optional supporter-claimed subtotal.
 * Outputs: Same receipt OCR shape as mindee-ocr (merchant, totals, subtotal, status).
 */
import { aiChatWithImages, aiProviderName, parseAiJson, resolveReceiptBedrockModelId } from "./ai-chat";
import { normalizeImageMediaType } from "./image-mime-sniff";
import {
  type MindeeOcrResult,
  type OcrExtractStatus,
  normalizeSubtotal,
} from "./mindee-ocr";

type BedrockReceiptExtract = {
  merchantName?: string | null;
  receiptNumber?: string | null;
  dateString?: string | null;
  timeString?: string | null;
  total?: number | null;
  tax?: number | null;
  tip?: number | null;
  subtotal?: number | null;
  lineItemsTotal?: number | null;
  documentType?: string | null;
  confidence?: number | null;
};

const RECEIPT_VISION_SYSTEM = `You extract structured data from receipt, invoice, or check images for a charity donation platform.

Return ONLY a JSON object with these keys:
- merchantName: string | null (store, restaurant, hotel, or check payee)
- receiptNumber: string | null
- dateString: string | null (YYYY-MM-DD when possible)
- timeString: string | null (HH:MM 24-hour if visible)
- total: number (final amount paid; 0 if unknown)
- tax: number (total tax; 0 if unknown)
- tip: number (gratuity; 0 if unknown)
- subtotal: number (pre-tax eligible purchase amount for donation — exclude tax and tip)
- lineItemsTotal: number (sum of visible line-item totals; 0 if not itemized)
- documentType: "receipt" | "invoice" | "check" | "other"
- confidence: number from 0 to 1

Rules:
- Read only what is visible; never invent amounts or merchant names.
- For checks: merchantName = payee; total and subtotal = check amount.
- For hotel/travel receipts: subtotal is typically room + eligible charges before tax.
- subtotal is the donation-eligible amount (usually total minus tax and tip).
- Use null for unknown strings and 0 for unknown numbers.`;

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function readNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function readText(value: unknown): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t ? t : null;
}

function parseReceiptDate(dateString: string | null, timeString: string | null): Date | null {
  if (!dateString) return null;
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return null;
  if (timeString) {
    const parts = timeString.split(":").map((p) => Number(p));
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
      parsed.setHours(parts[0], parts[1], parts[2] ?? 0, 0);
    }
  }
  return parsed;
}

function manualOnly(message: string, claimedSubtotal?: number | null): MindeeOcrResult {
  const claimed =
    claimedSubtotal != null && claimedSubtotal > 0 ? roundMoney(claimedSubtotal) : 0;
  return {
    ocrStatus: "needs_review",
    ocrProvider: null,
    ocrProcessedAt: new Date(),
    ocrExtractStatus: claimed > 0 ? "manual_only" : "failed",
    merchantName: null,
    receiptNumber: null,
    dateString: null,
    timeString: null,
    receiptDate: null,
    total: 0,
    tax: 0,
    tip: 0,
    totalLineItems: 0,
    subtotal: claimed,
    eligibleSubtotal: claimed,
    extractedJson: null,
    message,
    isManualSubtotal: true,
  };
}

function resultFromBedrockExtract(
  parsed: BedrockReceiptExtract,
  claimedSubtotal: number | null | undefined,
  rawJson: Record<string, unknown>,
): MindeeOcrResult {
  const total = roundMoney(readNumber(parsed.total));
  const tax = roundMoney(readNumber(parsed.tax));
  const tip = roundMoney(readNumber(parsed.tip));
  const totalLineItems = roundMoney(readNumber(parsed.lineItemsTotal));
  const rawSubtotal = roundMoney(readNumber(parsed.subtotal));
  const subtotal = normalizeSubtotal(rawSubtotal, total, tax, totalLineItems, tip);
  const claimed =
    claimedSubtotal != null && claimedSubtotal > 0 ? roundMoney(claimedSubtotal) : 0;
  const eligible = subtotal > 0 ? subtotal : claimed;
  const isManual = subtotal <= 0;
  const extractStatus: OcrExtractStatus =
    subtotal > 0 ? "completed" : claimed > 0 ? "manual_only" : "failed";

  const merchantName = readText(parsed.merchantName);
  const receiptNumber = readText(parsed.receiptNumber);
  const dateString = readText(parsed.dateString);
  const timeString = readText(parsed.timeString);

  return {
    ocrStatus: "needs_review",
    ocrProvider: "Bedrock",
    ocrProcessedAt: new Date(),
    ocrExtractStatus: extractStatus,
    merchantName,
    receiptNumber,
    dateString,
    timeString,
    receiptDate: parseReceiptDate(dateString, timeString),
    total,
    tax,
    tip,
    totalLineItems,
    subtotal: eligible,
    eligibleSubtotal: eligible,
    extractedJson: {
      merchantName,
      receiptNumber,
      dateString,
      timeString,
      total,
      tax,
      tip,
      subtotal,
      totalLineItems,
      documentType: readText(parsed.documentType),
      confidence: readNumber(parsed.confidence),
      provider: "Bedrock",
      fields: rawJson,
    },
    message:
      subtotal > 0
        ? "Receipt read successfully with AI. Pending staff review."
        : "AI could not confirm the subtotal. Enter it manually during review.",
    isManualSubtotal: isManual,
  };
}

/**
 * Calls Bedrock vision when AWS is configured; otherwise returns manual_only
 * (ocrProvider null) so the orchestrator can fall back to Mindee / placeholder.
 */
export async function extractReceiptWithBedrock(input: {
  imageBase64: string;
  mimeType: string;
  claimedSubtotal?: number | null;
  bedrockModelId?: string | null;
  userId?: number | null;
}): Promise<MindeeOcrResult> {
  if (aiProviderName() !== "bedrock") {
    return manualOnly(
      "AI receipt OCR requires AWS Bedrock credentials.",
      input.claimedSubtotal,
    );
  }

  try {
    const raw = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) {
      return manualOnly("Receipt image was empty.", input.claimedSubtotal);
    }

    const mime = normalizeImageMediaType(buffer, input.mimeType || "image/jpeg");
    const modelId = await resolveReceiptBedrockModelId(input.bedrockModelId, input.userId);
    const text = await aiChatWithImages({
      system: RECEIPT_VISION_SYSTEM,
      user:
        "Extract all visible receipt, invoice, or check fields from this image for donation eligibility review.",
      json: true,
      maxTokens: 1024,
      temperature: 0.1,
      images: [{ bytes: buffer, mediaType: mime }],
      modelId,
      userId: input.userId,
    });

    const parsed = parseAiJson<BedrockReceiptExtract>(text);
    const hasSignal =
      readText(parsed.merchantName) ||
      readNumber(parsed.total) > 0 ||
      readNumber(parsed.subtotal) > 0 ||
      readText(parsed.receiptNumber);

    if (!hasSignal) {
      return manualOnly(
        "AI could not read this receipt. Enter subtotal manually.",
        input.claimedSubtotal,
      );
    }

    return resultFromBedrockExtract(parsed, input.claimedSubtotal, parsed as Record<string, unknown>);
  } catch (err) {
    console.error("Bedrock receipt OCR error:", err);
    return manualOnly(
      "AI could not read the receipt. Enter subtotal manually.",
      input.claimedSubtotal,
    );
  }
}
