export type KnownOrganizationProfile = {
    organizationName: string;
    missionStatement: string;
    about: string;
    website: string;
    contactEmail: string;
    phone: string;
    location: string;
    causeCategory: string;
    city: string;
    state: string;
    ein: string;
    orgType: string;
    social: string[];
    outcome: "full" | "partial";
};
export declare function normalizeProfileDomain(raw: string): string;
export declare function findKnownOrganizationProfile(websiteOrDomain: string): KnownOrganizationProfile | null;
export declare function findKnownOrganizationByName(nameQuery: string): KnownOrganizationProfile | null;
