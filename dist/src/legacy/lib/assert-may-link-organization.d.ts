import type { Pool, PoolClient } from "pg";
type Db = Pool | PoolClient;
export type LinkOrgGuardResult = {
    ok: true;
} | {
    ok: false;
    status: number;
    error: string;
};
export declare function assertUserMayLinkOrganization(client: Db, params: {
    userId: number;
    organizationType: "nonprofit" | "business";
    organizationId: number;
}): Promise<LinkOrgGuardResult>;
export {};
