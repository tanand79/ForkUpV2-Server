import type { PoolClient } from "pg";
export declare function generateGuestClaimToken(): string;
export declare function guestClaimExpiryDate(from?: Date): Date;
export declare function issueGuestCampaignClaim(input: {
    connection?: PoolClient;
    campaignId: number;
    slug: string;
    campaignName: string;
    guestEmail: string;
}): Promise<{
    token: string;
    emailSent: boolean;
}>;
export type GuestClaimLookup = {
    campaignId: number;
    slug: string;
    campaignName: string;
    nonprofitId: number;
    guestEmail: string;
    expiresAt: Date;
    claimedAt: Date | null;
};
export declare function lookupGuestClaimToken(token: string): Promise<GuestClaimLookup | null>;
export declare function claimGuestCampaignForUser(userId: number, claim: GuestClaimLookup): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
    status: number;
}>;
