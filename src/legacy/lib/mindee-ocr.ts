/**
 * Mindee receipt OCR — Node-native HTTPS client (no .NET wiring, no npm SDK).
 *
 * Matches forkup-main EventController.ExtractReceiptDataFromMindee:
 * Mindee V2 enqueue + poll when MINDEE_MODEL_ID is set; otherwise V1 predict.
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
  tip: number;
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
  if (typeof field === "object") {
    const rec = field as Record<string, unknown>;
    if ("value" in rec) return readAmount(rec.value as AmountField);
    if ("amount" in rec) return readAmount(rec.amount as AmountField);
  }
  return 0;
}

function readText(field: TextField): string | null {
  if (field == null) return null;
  if (typeof field === "string") {
    const t = field.trim();
    if (!t || t.toLowerCase() === "invalid date") return null;
    return t;
  }
  if (typeof field === "number" && Number.isFinite(field)) return String(field);
  if (typeof field === "object" && "value" in field) {
    return readText(field.value as TextField);
  }
  return null;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.05;
}

/**
 * Mirrors old .NET NormalizeSubtotal, plus the later EventController fallback
 * (total − tax when net/line-items are missing).
 */
export function normalizeSubtotal(
  subtotal: number,
  total: number,
  tax: number,
  totalLineItems: number,
  tip = 0,
): number {
  if (subtotal > 0) {
    if (total > 0 && nearlyEqual(total - tax, subtotal)) {
      return roundMoney(subtotal);
    }
    if (totalLineItems > 0 && total > 0 && nearlyEqual(tax + totalLineItems, total)) {
      return roundMoney(totalLineItems);
    }
    if (tax === 0 && totalLineItems === 0 && tip > 0 && total > 0) {
      return roundMoney(total - tip);
    }
    return roundMoney(subtotal);
  }
  if (totalLineItems > 0 && total > 0 && nearlyEqual(tax + totalLineItems, total)) {
    return roundMoney(totalLineItems);
  }
  if (totalLineItems > 0 && tax === 0 && total === 0) {
    return roundMoney(totalLineItems);
  }
  if (tip > 0 && total > tip) {
    return roundMoney(total - tip);
  }
  if (total > 0 && tax >= 0 && total > tax) {
    return roundMoney(total - tax);
  }
  if (total > 0) return roundMoney(total);
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
    tip: 0,
    totalLineItems: 0,
    subtotal: claimed,
    eligibleSubtotal: claimed,
    extractedJson: null,
    message,
    isManualSubtotal: true,
  };
}

function parseLineItemsFromDump(rawText: string): number {
  let sum = 0;
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(/^:total_price:\s*(.+)$/i);
    if (!m) continue;
    const n = Number(String(m[1]).replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n)) sum += n;
  }
  return roundMoney(sum);
}

function lineItemPrice(item: unknown): number {
  if (!item || typeof item !== "object") return 0;
  const row = item as Record<string, unknown>;
  const nested = row.fields && typeof row.fields === "object" ? (row.fields as Record<string, unknown>) : row;
  return (
    readAmount(nested.total_amount as AmountField) ||
    readAmount(nested.total_price as AmountField) ||
    readAmount(nested.amount as AmountField)
  );
}

export function sumLineItems(lineItems: unknown): number {
  if (typeof lineItems === "string") return parseLineItemsFromDump(lineItems);
  if (!lineItems) return 0;
  if (Array.isArray(lineItems)) {
    let sum = 0;
    for (const item of lineItems) sum += lineItemPrice(item);
    return roundMoney(sum);
  }
  if (typeof lineItems === "object") {
    const rec = lineItems as Record<string, unknown>;
    if (Array.isArray(rec.items)) return sumLineItems(rec.items);
    if (Array.isArray(rec.value)) return sumLineItems(rec.value);
    const dumped = String((lineItems as { toString?: () => string }).toString?.() ?? "");
    if (dumped.includes(":total_price:")) return parseLineItemsFromDump(dumped);
  }
  return 0;
}

/** V2 fields are { name: { value } } or the field object itself. */
function fieldMap(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return fields && typeof fields === "object" ? fields : {};
}

function predictionFromV1Document(json: Record<string, unknown>): Record<string, unknown> {
  const document = json.document as Record<string, unknown> | undefined;
  const inference = document?.inference as Record<string, unknown> | undefined;
  if (inference?.prediction && typeof inference.prediction === "object") {
    return inference.prediction as Record<string, unknown>;
  }
  const pages = inference?.pages;
  if (Array.isArray(pages) && pages[0] && typeof pages[0] === "object") {
    const page = pages[0] as Record<string, unknown>;
    if (page.prediction && typeof page.prediction === "object") {
      return page.prediction as Record<string, unknown>;
    }
  }
  return {};
}

function fieldsFromV2Inference(json: Record<string, unknown>): Record<string, unknown> {
  const inference =
    (json.inference as Record<string, unknown> | undefined) ??
    ((json.job as Record<string, unknown> | undefined)?.inference as Record<string, unknown> | undefined);
  const result = inference?.result as Record<string, unknown> | undefined;
  const fields = result?.fields;
  if (fields && typeof fields === "object") return fields as Record<string, unknown>;
  return {};
}

function amountsFromFields(fields: Record<string, unknown>): {
  merchantName: string | null;
  receiptNumber: string | null;
  dateString: string | null;
  timeString: string | null;
  total: number;
  tax: number;
  tip: number;
  totalLineItems: number;
  rawSubtotal: number;
} {
  const f = fieldMap(fields);
  return {
    merchantName:
      readText(f.supplier_name as TextField) ??
      readText(f.merchant_name as TextField) ??
      readText(f.supplier as TextField),
    receiptNumber: readText(f.receipt_number as TextField),
    dateString: readText(f.date as TextField),
    timeString: readText(f.time as TextField),
    total: roundMoney(readAmount(f.total_amount as AmountField)),
    tax: roundMoney(readAmount(f.total_tax as AmountField)),
    tip: roundMoney(readAmount(f.tips_gratuity as AmountField) || readAmount(f.tip as AmountField)),
    totalLineItems: sumLineItems(f.line_items),
    rawSubtotal: readAmount(f.total_net as AmountField),
  };
}

function toMindeeFile(buffer: Buffer, mime: string): { file: Blob; filename: string } {
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const filename = `receipt.${ext}`;
  const bytes = new Uint8Array(buffer);
  const file =
    typeof File !== "undefined"
      ? new File([bytes], filename, { type: mime || "image/jpeg" })
      : new Blob([bytes], { type: mime || "image/jpeg" });
  return { file, filename };
}

function authHeaders(apiKey: string, style: "raw" | "token"): Record<string, string> {
  return {
    Authorization: style === "token" ? `Token ${apiKey}` : apiKey,
  };
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const bodyText = await res.text();
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return { _raw: bodyText.slice(0, 400) };
  }
}

async function pollJob(
  pollingUrl: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetch(pollingUrl, { method: "GET", headers });
    last = await parseJson(res);
    const job = (last.job as Record<string, unknown> | undefined) ?? last;
    const status = String(job.status ?? "").toLowerCase();
    if (status === "processed" || status === "completed" || last.inference) {
      const resultUrl = typeof job.result_url === "string" ? job.result_url : null;
      if (resultUrl && !last.inference) {
        const got = await fetch(resultUrl, { method: "GET", headers });
        const body = await parseJson(got);
        if (got.ok) return body;
      }
      return last;
    }
    if (status === "failed" || status === "error") {
      const err = job.error as Record<string, unknown> | undefined;
      throw new Error(String(err?.detail ?? err?.message ?? "Mindee job failed"));
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`Mindee poll HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Mindee timed out waiting for OCR");
}

function v2EnqueueUrls(): string[] {
  const configured = config.mindee.v2EnqueueUrl;
  const defaults = [
    "https://api-v2.mindee.net/v2/inferences/enqueue",
    "https://api.mindee.net/v2/inferences/enqueue",
  ];
  return [...new Set([configured, ...defaults])];
}

async function extractWithV2(
  buffer: Buffer,
  mime: string,
  apiKey: string,
  modelId: string,
): Promise<Record<string, unknown>> {
  const { file, filename } = toMindeeFile(buffer, mime);
  const styles: Array<"raw" | "token"> = apiKey.startsWith("md_") ? ["raw", "token"] : ["token", "raw"];
  let lastError = "Mindee V2 enqueue failed";

  for (const enqueueUrl of v2EnqueueUrls()) {
    for (const style of styles) {
      const form = new FormData();
      form.append("model_id", modelId);
      form.append("file", file, filename);
      form.append("filename", filename);

      const headers = authHeaders(apiKey, style);
      const res = await fetch(enqueueUrl, {
        method: "POST",
        headers,
        body: form,
      });
      const json = await parseJson(res);
      if (!res.ok && res.status !== 202) {
        lastError = `Mindee V2 HTTP ${res.status}`;
        console.error("Mindee V2 enqueue error:", res.status, JSON.stringify(json).slice(0, 400));
        if (res.status === 401 || res.status === 403 || res.status === 404) continue;
        throw new Error(lastError);
      }
      const job = (json.job as Record<string, unknown> | undefined) ?? json;
      const pollingUrl =
        (typeof job.polling_url === "string" && job.polling_url) ||
        (typeof json.polling_url === "string" && json.polling_url) ||
        null;
      if (json.inference) return json;
      if (!pollingUrl) {
        lastError = "Mindee V2 did not return a polling URL";
        continue;
      }
      return pollJob(pollingUrl, headers);
    }
  }
  throw new Error(lastError);
}

async function extractWithV1(
  buffer: Buffer,
  mime: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const { file, filename } = toMindeeFile(buffer, mime);
  const form = new FormData();
  form.append("document", file, filename);

  const res = await fetch(config.mindee.apiUrl, {
    method: "POST",
    headers: authHeaders(apiKey, "token"),
    body: form,
  });
  const json = await parseJson(res);
  if (!res.ok) {
    console.error("Mindee V1 HTTP error:", res.status, JSON.stringify(json).slice(0, 400));
    throw new Error(`Mindee V1 HTTP ${res.status}`);
  }
  return json;
}

function resultFromExtract(
  fields: Record<string, unknown>,
  claimedSubtotal: number | null | undefined,
): MindeeOcrResult {
  const parsed = amountsFromFields(fields);
  const subtotal = normalizeSubtotal(
    parsed.rawSubtotal,
    parsed.total,
    parsed.tax,
    parsed.totalLineItems,
    parsed.tip,
  );
  const claimed =
    claimedSubtotal != null && claimedSubtotal > 0 ? roundMoney(claimedSubtotal) : 0;
  const eligible = subtotal > 0 ? subtotal : claimed;
  const isManual = subtotal <= 0;
  const extractStatus: OcrExtractStatus =
    subtotal > 0 ? "completed" : claimed > 0 ? "manual_only" : "failed";

  return {
    ocrStatus: "needs_review",
    ocrProvider: "Mindee",
    ocrProcessedAt: new Date(),
    ocrExtractStatus: extractStatus,
    merchantName: parsed.merchantName,
    receiptNumber: parsed.receiptNumber,
    dateString: parsed.dateString,
    timeString: parsed.timeString,
    receiptDate: parseReceiptDate(parsed.dateString, parsed.timeString),
    total: parsed.total,
    tax: parsed.tax,
    tip: parsed.tip,
    totalLineItems: parsed.totalLineItems,
    subtotal: eligible,
    eligibleSubtotal: eligible,
    extractedJson: {
      merchantName: parsed.merchantName,
      receiptNumber: parsed.receiptNumber,
      dateString: parsed.dateString,
      timeString: parsed.timeString,
      total: parsed.total,
      tax: parsed.tax,
      tip: parsed.tip,
      subtotal,
      totalLineItems: parsed.totalLineItems,
      fields,
    },
    message:
      subtotal > 0
        ? "Receipt read successfully. Pending staff review."
        : "Mindee could not confirm the subtotal. Enter it manually during review.",
    isManualSubtotal: isManual,
  };
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
    const modelId = config.mindee.modelId;
    let json: Record<string, unknown> = {};
    let fields: Record<string, unknown> = {};

    if (modelId) {
      try {
        json = await extractWithV2(buffer, mime, apiKey, modelId);
        fields = fieldsFromV2Inference(json);
        if (Object.keys(fields).length === 0) {
          fields = predictionFromV1Document(json);
        }
      } catch (v2Err) {
        console.error("Mindee V2 failed, trying V1 predict:", v2Err);
      }
    }
    if (Object.keys(fields).length === 0) {
      json = await extractWithV1(buffer, mime, apiKey);
      fields = predictionFromV1Document(json);
    }

    if (Object.keys(fields).length === 0) {
      return manualOnly(
        "Mindee could not read the receipt. Enter subtotal manually.",
        input.claimedSubtotal,
      );
    }

    return resultFromExtract(fields, input.claimedSubtotal);
  } catch (err) {
    console.error("Mindee OCR error:", err);
    return manualOnly(
      "Mindee could not read the receipt. Enter subtotal manually.",
      input.claimedSubtotal,
    );
  }
}
