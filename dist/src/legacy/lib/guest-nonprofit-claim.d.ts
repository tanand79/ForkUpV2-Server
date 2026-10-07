import type { PoolClient } from "pg";
export declare function generateGuestNonprofitClaimToken(): string;
export declare function guestNonprofitClaimExpiryDate(from?: Date): Date;
export declare function issueGuestNonprofitClaim(input: {
    connection?: PoolClient;
    nonprofitId: number;
    slug: string;
    organizationName: string;
    guestEmail: string;
}): Promise<{
    token: string;
    emailSent: boolean;
}>;
export type GuestNonprofitClaimLookup = {
    nonprofitId: number;
    slug: string;
    organizationName: string;
    guestEmail: string;
    expiresAt: Date;
    claimedAt: Date | null;
};
export declare function lookupGuestNonprofitClaimToken(token: string): Promise<GuestNonprofitClaimLookup | null>;
export declare function claimGuestNonprofitForUser(userId: number, claim: GuestNonprofitClaimLookup): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
    status: number;
}>;
