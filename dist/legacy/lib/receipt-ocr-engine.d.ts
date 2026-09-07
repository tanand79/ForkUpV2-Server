import { type MindeeOcrResult } from "./mindee-ocr";
export declare function extractReceiptOcr(input: {
    imageBase64: string;
    mimeType: string;
    claimedSubtotal?: number | null;
    bedrockModelId?: string | null;
    userId?: number | null;
}): Promise<MindeeOcrResult>;
