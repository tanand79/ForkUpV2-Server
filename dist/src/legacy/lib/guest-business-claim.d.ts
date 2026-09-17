import type { PoolClient } from "pg";
export declare function generateGuestBusinessClaimToken(): string;
export declare function guestBusinessClaimExpiryDate(from?: Date): Date;
export declare function issueGuestBusinessClaim(input: {
    connection?: PoolClient;
    businessId: number;
    slug: string;
    businessName: string;
    guestEmail: string;
}): Promise<{
    token: string;
    emailSent: boolean;
}>;
export type GuestBusinessClaimLookup = {
    businessId: number;
    slug: string;
    businessName: string;
    guestEmail: string;
    expiresAt: Date;
    claimedAt: Date | null;
};
export declare function lookupGuestBusinessClaimToken(token: string): Promise<GuestBusinessClaimLookup | null>;
export declare function claimGuestBusinessForUser(userId: number, claim: GuestBusinessClaimLookup): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
    status: number;
}>;
