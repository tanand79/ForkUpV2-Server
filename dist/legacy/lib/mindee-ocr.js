"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSubtotal = normalizeSubtotal;
exports.sumLineItems = sumLineItems;
exports.extractReceiptWithMindee = extractReceiptWithMindee;
const config_1 = require("../config");
function roundMoney(n) {
    return Math.round(n * 100) / 100;
}
function readAmount(field) {
    if (field == null)
        return 0;
    if (typeof field === "number")
        return Number.isFinite(field) ? field : 0;
    if (typeof field === "string") {
        const n = Number(field.replace(/[^0-9.-]/g, ""));
        return Number.isFinite(n) ? n : 0;
    }
    if (typeof field === "object") {
        const rec = field;
        if ("value" in rec)
            return readAmount(rec.value);
        if ("amount" in rec)
            return readAmount(rec.amount);
    }
    return 0;
}
function readText(field) {
    if (field == null)
        return null;
    if (typeof field === "string") {
        const t = field.trim();
        if (!t || t.toLowerCase() === "invalid date")
            return null;
        return t;
    }
    if (typeof field === "number" && Number.isFinite(field))
        return String(field);
    if (typeof field === "object" && "value" in field) {
        return readText(field.value);
    }
    return null;
}
function nearlyEqual(a, b) {
    return Math.abs(a - b) <= 0.05;
}
function normalizeSubtotal(subtotal, total, tax, totalLineItems, tip = 0) {
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
    if (total > 0)
        return roundMoney(total);
    return 0;
}
function parseReceiptDate(dateString, timeString) {
    if (!dateString)
        return null;
    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime()))
        return null;
    if (timeString) {
        const parts = timeString.split(":").map((p) => Number(p));
        if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
            parsed.setHours(parts[0], parts[1], parts[2] ?? 0, 0);
        }
    }
    return parsed;
}
function manualOnly(message, claimedSubtotal) {
    const claimed = claimedSubtotal != null && claimedSubtotal > 0 ? roundMoney(claimedSubtotal) : 0;
    return {
        ocrStatus: "needs_review",
        ocrProvider: config_1.config.mindee.apiKey ? "Mindee" : null,
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
function parseLineItemsFromDump(rawText) {
    let sum = 0;
    for (const line of rawText.split("\n")) {
        const trimmed = line.trim();
        const m = trimmed.match(/^:total_price:\s*(.+)$/i);
        if (!m)
            continue;
        const n = Number(String(m[1]).replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(n))
            sum += n;
    }
    return roundMoney(sum);
}
function lineItemPrice(item) {
    if (!item || typeof item !== "object")
        return 0;
    const row = item;
    const nested = row.fields && typeof row.fields === "object" ? row.fields : row;
    return (readAmount(nested.total_amount) ||
        readAmount(nested.total_price) ||
        readAmount(nested.amount));
}
function sumLineItems(lineItems) {
    if (typeof lineItems === "string")
        return parseLineItemsFromDump(lineItems);
    if (!lineItems)
        return 0;
    if (Array.isArray(lineItems)) {
        let sum = 0;
        for (const item of lineItems)
            sum += lineItemPrice(item);
        return roundMoney(sum);
    }
    if (typeof lineItems === "object") {
        const rec = lineItems;
        if (Array.isArray(rec.items))
            return sumLineItems(rec.items);
        if (Array.isArray(rec.value))
            return sumLineItems(rec.value);
        const dumped = String(lineItems.toString?.() ?? "");
        if (dumped.includes(":total_price:"))
            return parseLineItemsFromDump(dumped);
    }
    return 0;
}
function fieldMap(fields) {
    return fields && typeof fields === "object" ? fields : {};
}
function predictionFromV1Document(json) {
    const document = json.document;
    const inference = document?.inference;
    if (inference?.prediction && typeof inference.prediction === "object") {
        return inference.prediction;
    }
    const pages = inference?.pages;
    if (Array.isArray(pages) && pages[0] && typeof pages[0] === "object") {
        const page = pages[0];
        if (page.prediction && typeof page.prediction === "object") {
            return page.prediction;
        }
    }
    return {};
}
function fieldsFromV2Inference(json) {
    const inference = json.inference ??
        json.job?.inference;
    const result = inference?.result;
    const fields = result?.fields;
    if (fields && typeof fields === "object")
        return fields;
    return {};
}
function amountsFromFields(fields) {
    const f = fieldMap(fields);
    return {
        merchantName: readText(f.supplier_name) ??
            readText(f.merchant_name) ??
            readText(f.supplier),
        receiptNumber: readText(f.receipt_number),
        dateString: readText(f.date),
        timeString: readText(f.time),
        total: roundMoney(readAmount(f.total_amount)),
        tax: roundMoney(readAmount(f.total_tax)),
        tip: roundMoney(readAmount(f.tips_gratuity) || readAmount(f.tip)),
        totalLineItems: sumLineItems(f.line_items),
        rawSubtotal: readAmount(f.total_net),
    };
}
function toMindeeFile(buffer, mime) {
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const filename = `receipt.${ext}`;
    const bytes = new Uint8Array(buffer);
    const file = typeof File !== "undefined"
        ? new File([bytes], filename, { type: mime || "image/jpeg" })
        : new Blob([bytes], { type: mime || "image/jpeg" });
    return { file, filename };
}
function authHeaders(apiKey, style) {
    return {
        Authorization: style === "token" ? `Token ${apiKey}` : apiKey,
    };
}
async function parseJson(res) {
    const bodyText = await res.text();
    if (!bodyText)
        return {};
    try {
        return JSON.parse(bodyText);
    }
    catch {
        return { _raw: bodyText.slice(0, 400) };
    }
}
async function pollJob(pollingUrl, headers) {
    const deadline = Date.now() + 45_000;
    let last = {};
    while (Date.now() < deadline) {
        const res = await fetch(pollingUrl, { method: "GET", headers });
        last = await parseJson(res);
        const job = last.job ?? last;
        const status = String(job.status ?? "").toLowerCase();
        if (status === "processed" || status === "completed" || last.inference) {
            const resultUrl = typeof job.result_url === "string" ? job.result_url : null;
            if (resultUrl && !last.inference) {
                const got = await fetch(resultUrl, { method: "GET", headers });
                const body = await parseJson(got);
                if (got.ok)
                    return body;
            }
            return last;
        }
        if (status === "failed" || status === "error") {
            const err = job.error;
            throw new Error(String(err?.detail ?? err?.message ?? "Mindee job failed"));
        }
        if (!res.ok && res.status !== 202) {
            throw new Error(`Mindee poll HTTP ${res.status}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Mindee timed out waiting for OCR");
}
function v2EnqueueUrls() {
    const configured = config_1.config.mindee.v2EnqueueUrl;
    const defaults = [
        "https://api-v2.mindee.net/v2/inferences/enqueue",
        "https://api.mindee.net/v2/inferences/enqueue",
    ];
    return [...new Set([configured, ...defaults])];
}
async function extractWithV2(buffer, mime, apiKey, modelId) {
    const { file, filename } = toMindeeFile(buffer, mime);
    const styles = apiKey.startsWith("md_") ? ["raw", "token"] : ["token", "raw"];
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
                if (res.status === 401 || res.status === 403 || res.status === 404)
                    continue;
                throw new Error(lastError);
            }
            const job = json.job ?? json;
            const pollingUrl = (typeof job.polling_url === "string" && job.polling_url) ||
                (typeof json.polling_url === "string" && json.polling_url) ||
                null;
            if (json.inference)
                return json;
            if (!pollingUrl) {
                lastError = "Mindee V2 did not return a polling URL";
                continue;
            }
            return pollJob(pollingUrl, headers);
        }
    }
    throw new Error(lastError);
}
async function extractWithV1(buffer, mime, apiKey) {
    const { file, filename } = toMindeeFile(buffer, mime);
    const form = new FormData();
    form.append("document", file, filename);
    const res = await fetch(config_1.config.mindee.apiUrl, {
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
function resultFromExtract(fields, claimedSubtotal) {
    const parsed = amountsFromFields(fields);
    const subtotal = normalizeSubtotal(parsed.rawSubtotal, parsed.total, parsed.tax, parsed.totalLineItems, parsed.tip);
    const claimed = claimedSubtotal != null && claimedSubtotal > 0 ? roundMoney(claimedSubtotal) : 0;
    const eligible = subtotal > 0 ? subtotal : claimed;
    const isManual = subtotal <= 0;
    const extractStatus = subtotal > 0 ? "completed" : claimed > 0 ? "manual_only" : "failed";
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
        message: subtotal > 0
            ? "Receipt read successfully. Pending staff review."
            : "Mindee could not confirm the subtotal. Enter it manually during review.",
        isManualSubtotal: isManual,
    };
}
async function extractReceiptWithMindee(input) {
    const apiKey = config_1.config.mindee.apiKey;
    if (!apiKey) {
        return manualOnly("OCR engine is not configured. Enter amount during review.", input.claimedSubtotal);
    }
    try {
        const raw = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(raw, "base64");
        if (buffer.length === 0) {
            return manualOnly("Receipt image was empty.", input.claimedSubtotal);
        }
        const mime = input.mimeType || "image/jpeg";
        const modelId = config_1.config.mindee.modelId;
        let json = {};
        let fields = {};
        if (modelId) {
            try {
                json = await extractWithV2(buffer, mime, apiKey, modelId);
                fields = fieldsFromV2Inference(json);
                if (Object.keys(fields).length === 0) {
                    fields = predictionFromV1Document(json);
                }
            }
            catch (v2Err) {
                console.error("Mindee V2 failed, trying V1 predict:", v2Err);
            }
        }
        if (Object.keys(fields).length === 0) {
            json = await extractWithV1(buffer, mime, apiKey);
            fields = predictionFromV1Document(json);
        }
        if (Object.keys(fields).length === 0) {
            return manualOnly("Mindee could not read the receipt. Enter subtotal manually.", input.claimedSubtotal);
        }
        return resultFromExtract(fields, input.claimedSubtotal);
    }
    catch (err) {
        console.error("Mindee OCR error:", err);
        return manualOnly("Mindee could not read the receipt. Enter subtotal manually.", input.claimedSubtotal);
    }
}
//# sourceMappingURL=mindee-ocr.js.map