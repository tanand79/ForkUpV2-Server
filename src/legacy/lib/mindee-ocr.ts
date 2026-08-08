/**
 * Mindee receipt OCR — Node-native HTTPS client (no .NET wiring, no npm SDK).
 *
 * Purpose: extract subtotal / merchant / date from a receipt image via Mindee
 * v1 expense_receipts predict (configurable URL).
 *
 * Inputs: base64 image + mime type (+ optional claimed subtotal for merge).
 * Outputs: structured extract matching receipts OCR columns; never throws.
 */
import { config } from "../config";

export type OcrExtractStatus = "pending" | "completed" | "failed" | "manual_only";

export interface MindeeOcrResult {
  /** Staff pipeline status — always needs_review until approve/reject. */
  ocrStatus: "needs_review";
  ocrProvider: string | null;
  ocrProcessedAt: Date | null;
  ocrExtractStatus: OcrExtractStatus;
  merchantName: string | null;
  receiptNumber: string | null;
  dateString: string | null;
  timeString: string | null;
  receiptDate: Date | null;
  total: number;
  tax: number;
  totalLineItems: number;
  /** Canonical eligible amount for donation math when > 0. */
  subtotal: number;
  eligibleSubtotal: number;
  extractedJson: Record<string, unknown> | null;
  message: string;
  isManualSubtotal: boolean;
}

type AmountField = { value?: number | string | null } | number | string | null | undefined;
type TextField = { value?: string | null } | string | null | undefined;

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function readAmount(field: AmountField): number {
  if (field == null) return 0;
  if (typeof field === "number") return Number.isFinite(field) ? field : 0;
  if (typeof field === "string") {
    const n = Number(field.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof field === "object" && "value" in field) {
    return readAmount(field.value as AmountField);
  }
  return 0;
}

function readText(field: TextField): string | null {
  if (field == null) return null;
  if (typeof field === "string") {
    const t = field.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof field === "object" && "value" in field) {
    return readText(field.value as TextField);
  }
  return null;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.05;
}

/**
 * Mirrors old .NET NormalizeSubtotal: prefer verified total_net, else line items.
 */
export function normalizeSubtotal(
  subtotal: number,
  total: number,
  tax: number,
  totalLineItems: number,
): number {
  if (subtotal > 0) {
    if (total > 0 && nearlyEqual(total - tax, subtotal)) {
      return roundMoney(subtotal);
    }
    if (totalLineItems > 0 && total > 0 && nearlyEqual(tax + totalLineItems, total)) {
      return roundMoney(totalLineItems);
    }
    return roundMoney(subtotal);
  }
  if (totalLineItems > 0 && total > 0 && nearlyEqual(tax + totalLineItems, total)) {
    return roundMoney(totalLineItems);
  }
  return 0;
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
    ocrProvider: config.mindee.apiKey ? "Mindee" : null,
    ocrProcessedAt: new Date(),
    ocrExtractStatus: claimed > 0 ? "manual_only" : "failed",
    merchantName: null,
    receiptNumber: null,
    dateString: null,
    timeString: null,
    receiptDate: null,
    total: 0,
    tax: 0,
    totalLineItems: 0,
    subtotal: claimed,
    eligibleSubtotal: claimed,
    extractedJson: null,
    message,
    isManualSubtotal: true,
  };
}

function sumLineItems(lineItems: unknown): number {
  if (!Array.isArray(lineItems)) return 0;
  let sum = 0;
  for (const item of lineItems) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const price =
      readAmount(row.total_amount as AmountField) ||
      readAmount(row.total_price as AmountField) ||
      readAmount(row.amount as AmountField);
    sum += price;
  }
  return roundMoney(sum);
}

/**
 * Calls Mindee when configured; otherwise / on failure returns manual_only
 * using claimedSubtotal when provided.
 */
export async function extractReceiptWithMindee(input: {
  imageBase64: string;
  mimeType: string;
  claimedSubtotal?: number | null;
}): Promise<MindeeOcrResult> {
  const apiKey = config.mindee.apiKey;
  if (!apiKey) {
    return manualOnly(
      "OCR engine is not configured. Enter amount during review.",
      input.claimedSubtotal,
    );
  }

  try {
    const raw = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) {
      return manualOnly("Receipt image was empty.", input.claimedSubtotal);
    }

    const mime = input.mimeType || "image/jpeg";
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const form = new FormData();
    form.append(
      "document",
      new Blob([buffer], { type: mime }),
      `receipt.${ext}`,
    );

    const res = await fetch(config.mindee.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
      },
      body: form,
    });

    const bodyText = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      return manualOnly(
        "Mindee returned a non-JSON response. Enter subtotal manually.",
        input.claimedSubtotal,
      );
    }

    if (!res.ok) {
      console.error("Mindee OCR HTTP error:", res.status, bodyText.slice(0, 500));
      return manualOnly(
        "Mindee could not read the receipt. Enter subtotal manually.",
        input.claimedSubtotal,
      );
    }

    const document = json.document as Record<string, unknown> | undefined;
    const inference = document?.inference as Record<string, unknown> | undefined;
    const prediction = (inference?.prediction ?? {}) as Record<string, unknown>;

    const merchantName =
      readText(prediction.supplier_name as TextField) ??
      readText(prediction.merchant_name as TextField) ??
      readText(prediction.supplier as TextField);

    const receiptNumber = readText(prediction.receipt_number as TextField);
    const dateString = readText(prediction.date as TextField);
    const timeString = readText(prediction.time as TextField);
    const total = roundMoney(readAmount(prediction.total_amount as AmountField));
    const tax = roundMoney(readAmount(prediction.total_tax as AmountField));
    const totalLineItems = sumLineItems(prediction.line_items);
    const rawSubtotal = readAmount(prediction.total_net as AmountField);
    const subtotal = normalizeSubtotal(rawSubtotal, total, tax, totalLineItems);

    const claimed =
      input.claimedSubtotal != null && input.claimedSubtotal > 0
        ? roundMoney(input.claimedSubtotal)
        : 0;
    const eligible = subtotal > 0 ? subtotal : claimed;
    const isManual = subtotal <= 0;
    const extractStatus: OcrExtractStatus =
      subtotal > 0 ? "completed" : claimed > 0 ? "manual_only" : "failed";

    const extractedJson = {
      merchantName,
      receiptNumber,
      dateString,
      timeString,
      total,
      tax,
      subtotal,
      totalLineItems,
      prediction,
    };

    return {
      ocrStatus: "needs_review",
      ocrProvider: "Mindee",
      ocrProcessedAt: new Date(),
      ocrExtractStatus: extractStatus,
      merchantName,
      receiptNumber,
      dateString,
      timeString,
      receiptDate: parseReceiptDate(dateString, timeString),
      total,
      tax,
      totalLineItems,
      subtotal: eligible,
      eligibleSubtotal: eligible,
      extractedJson,
      message:
        subtotal > 0
          ? "Receipt read successfully. Pending staff review."
          : "Mindee could not confirm the subtotal. Enter it manually during review.",
      isManualSubtotal: isManual,
    };
  } catch (err) {
    console.error("Mindee OCR error:", err);
    return manualOnly(
      "Mindee could not read the receipt. Enter subtotal manually.",
      input.claimedSubtotal,
    );
  }
}
