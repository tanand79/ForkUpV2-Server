import type { AuthUser } from "./auth";
export type NonprofitProfileDto = {
    id: number;
    organizationName: string;
    slug: string;
    mission: string | null;
    website: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    causeCategory: string | null;
    verificationStatus: string;
    claimStatus: string;
    profileStatus: string;
    verified: boolean;
};
export type BusinessProfileDto = {
    id: number;
    businessName: string;
    slug: string;
    businessType: string | null;
    website: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    businessStatus: string;
    claimStatus: string;
    profileStatus: string;
    defaultGivebackPercentage: number;
    capabilities: {
        dineAndDonate: boolean;
        shopAndDonate: boolean;
        serviceGiveback: boolean;
        guestBartending: boolean;
    };
    locations: {
        id: number;
        locationName: string;
        city: string | null;
        state: string | null;
        address: string | null;
    }[];
};
export declare function loadUserNonprofitProfiles(user: AuthUser): Promise<NonprofitProfileDto[]>;
export declare function loadUserBusinessProfiles(user: AuthUser): Promise<BusinessProfileDto[]>;
