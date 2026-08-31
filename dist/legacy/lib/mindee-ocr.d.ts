export type OcrExtractStatus = "pending" | "completed" | "failed" | "manual_only";
export interface MindeeOcrResult {
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
    subtotal: number;
    eligibleSubtotal: number;
    extractedJson: Record<string, unknown> | null;
    message: string;
    isManualSubtotal: boolean;
}
export declare function normalizeSubtotal(subtotal: number, total: number, tax: number, totalLineItems: number, tip?: number): number;
export declare function sumLineItems(lineItems: unknown): number;
export declare function extractReceiptWithMindee(input: {
    imageBase64: string;
    mimeType: string;
    claimedSubtotal?: number | null;
}): Promise<MindeeOcrResult>;
