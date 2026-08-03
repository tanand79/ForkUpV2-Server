import type { PoolClient } from "pg";
export type BusinessInvitationInsertInput = {
    campaignId: number;
    nonprofitId: number;
    methodId: number;
    businessId: number;
    businessName: string;
    businessEmail: string;
    campaignBusinessLocationId: number;
    respondByDate: string | null;
    invitedByUserId?: number | null;
    proposedGivebackPercentage: number;
    messageToBusiness?: string | null;
    proposedTerms?: string | null;
};
export declare function insertBusinessInvitationRecord(connection: PoolClient, input: BusinessInvitationInsertInput): Promise<void>;
export declare function syncBusinessInvitationAccepted(connection: PoolClient, input: {
    campaignBusinessLocationId: number;
    invitationStatus: "needs_info" | "ready";
    setupStatus: string;
    marketingReadyStatus: string;
    settlementReadyStatus: string;
}): Promise<void>;
export declare function syncBusinessInvitationDeclined(connection: PoolClient, input: {
    campaignBusinessLocationId: number;
    declineReason?: string | null;
}): Promise<void>;
export declare function syncBusinessInvitationNeedsInfo(connection: PoolClient, campaignBusinessLocationIds: number[]): Promise<void>;
