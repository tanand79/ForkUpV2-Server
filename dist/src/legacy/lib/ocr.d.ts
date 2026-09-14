export interface OcrResult {
    subtotal: number;
    eligibleSubtotal: number;
    confidence: number;
    status: "needs_review" | "approved";
    notes: string;
}
export declare function processReceiptOcr(claimedSubtotal?: number | null): OcrResult;
