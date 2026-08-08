"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSubtotal = normalizeSubtotal;
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
    if (typeof field === "object" && "value" in field) {
        return readAmount(field.value);
    }
    return 0;
}
function readText(field) {
    if (field == null)
        return null;
    if (typeof field === "string") {
        const t = field.trim();
        return t.length > 0 ? t : null;
    }
    if (typeof field === "object" && "value" in field) {
        return readText(field.value);
    }
    return null;
}
function nearlyEqual(a, b) {
    return Math.abs(a - b) <= 0.05;
}
function normalizeSubtotal(subtotal, total, tax, totalLineItems) {
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
        totalLineItems: 0,
        subtotal: claimed,
        eligibleSubtotal: claimed,
        extractedJson: null,
        message,
        isManualSubtotal: true,
    };
}
function sumLineItems(lineItems) {
    if (!Array.isArray(lineItems))
        return 0;
    let sum = 0;
    for (const item of lineItems) {
        if (!item || typeof item !== "object")
            continue;
        const row = item;
        const price = readAmount(row.total_amount) ||
            readAmount(row.total_price) ||
            readAmount(row.amount);
        sum += price;
    }
    return roundMoney(sum);
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
        const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
        const form = new FormData();
        form.append("document", new Blob([buffer], { type: mime }), `receipt.${ext}`);
        const res = await fetch(config_1.config.mindee.apiUrl, {
            method: "POST",
            headers: {
                Authorization: `Token ${apiKey}`,
            },
            body: form,
        });
        const bodyText = await res.text();
        let json = {};
        try {
            json = bodyText ? JSON.parse(bodyText) : {};
        }
        catch {
            return manualOnly("Mindee returned a non-JSON response. Enter subtotal manually.", input.claimedSubtotal);
        }
        if (!res.ok) {
            console.error("Mindee OCR HTTP error:", res.status, bodyText.slice(0, 500));
            return manualOnly("Mindee could not read the receipt. Enter subtotal manually.", input.claimedSubtotal);
        }
        const document = json.document;
        const inference = document?.inference;
        const prediction = (inference?.prediction ?? {});
        const merchantName = readText(prediction.supplier_name) ??
            readText(prediction.merchant_name) ??
            readText(prediction.supplier);
        const receiptNumber = readText(prediction.receipt_number);
        const dateString = readText(prediction.date);
        const timeString = readText(prediction.time);
        const total = roundMoney(readAmount(prediction.total_amount));
        const tax = roundMoney(readAmount(prediction.total_tax));
        const totalLineItems = sumLineItems(prediction.line_items);
        const rawSubtotal = readAmount(prediction.total_net);
        const subtotal = normalizeSubtotal(rawSubtotal, total, tax, totalLineItems);
        const claimed = input.claimedSubtotal != null && input.claimedSubtotal > 0
            ? roundMoney(input.claimedSubtotal)
            : 0;
        const eligible = subtotal > 0 ? subtotal : claimed;
        const isManual = subtotal <= 0;
        const extractStatus = subtotal > 0 ? "completed" : claimed > 0 ? "manual_only" : "failed";
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
            message: subtotal > 0
                ? "Receipt read successfully. Pending staff review."
                : "Mindee could not confirm the subtotal. Enter it manually during review.",
            isManualSubtotal: isManual,
        };
    }
    catch (err) {
        console.error("Mindee OCR error:", err);
        return manualOnly("Mindee could not read the receipt. Enter subtotal manually.", input.claimedSubtotal);
    }
}
//# sourceMappingURL=mindee-ocr.js.map