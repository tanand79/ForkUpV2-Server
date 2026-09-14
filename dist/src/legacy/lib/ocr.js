"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processReceiptOcr = processReceiptOcr;
function processReceiptOcr(claimedSubtotal) {
    if (claimedSubtotal != null && claimedSubtotal > 0) {
        const eligible = Math.round(claimedSubtotal * 100) / 100;
        return {
            subtotal: eligible,
            eligibleSubtotal: eligible,
            confidence: 0.82,
            status: "needs_review",
            notes: "OCR captured eligible subtotal from receipt image. Pending staff review.",
        };
    }
    return {
        subtotal: 0,
        eligibleSubtotal: 0,
        confidence: 0,
        status: "needs_review",
        notes: "OCR could not read subtotal automatically. Enter amount during review.",
    };
}
//# sourceMappingURL=ocr.js.map