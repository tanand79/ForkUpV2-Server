import type { PoolClient } from "pg";
export declare function generateInvitationToken(): string;
export declare function ensureInvitationToken(connection: PoolClient, campaignBusinessLocationId: number): Promise<string>;
export declare function evaluateCampaignInvitationPhase(connection: PoolClient, campaignId: number): Promise<void>;
export declare function maybePromoteCampaignToLive(connection: PoolClient, campaignId: number): Promise<void>;
