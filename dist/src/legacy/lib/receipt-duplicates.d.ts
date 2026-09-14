import type { PoolClient } from "pg";
export type ReceiptDuplicateProbe = {
    receiptNumber?: string | null;
    dateString?: string | null;
    timeString?: string | null;
    subtotal?: number | null;
    total?: number | null;
};
export type DuplicateReceiptHit = {
    receiptId: number;
    reason: string;
};
export declare function findDuplicateReceipt(connection: PoolClient, campaignId: number, locationId: number, probe: ReceiptDuplicateProbe, excludeReceiptId?: number): Promise<DuplicateReceiptHit | null>;
