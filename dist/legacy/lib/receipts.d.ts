import type { PoolClient } from "pg";
export declare const UPLOADS_DIR: string;
export declare function ensureUploadsDir(): void;
export declare function saveReceiptImage(base64: string, mimeType: string): string;
export declare function calculateDonation(eligibleSubtotal: number, givebackPercentage: number): number;
export declare function approveReceipt(connection: PoolClient, receiptId: number, eligibleSubtotal?: number): Promise<void>;
export declare function rejectReceipt(connection: PoolClient, receiptId: number): Promise<void>;
