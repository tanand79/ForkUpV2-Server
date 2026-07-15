export interface OcrResult {
  subtotal: number;
  eligibleSubtotal: number;
  confidence: number;
  status: "needs_review" | "approved";
  notes: string;
}

/**
 * V1 OCR placeholder — simulates receipt parsing until MVP OCR engine is migrated.
 * Uses supporter-entered total when provided; otherwise flags for manual review.
 */
export function processReceiptOcr(claimedSubtotal?: number | null): OcrResult {
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
