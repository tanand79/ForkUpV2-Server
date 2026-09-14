import type { PoolClient } from "pg";
export declare function promoteFundraiserDraftOnAccept(connection: PoolClient, campaignId: number, startDate?: string | Date | null): Promise<string>;
