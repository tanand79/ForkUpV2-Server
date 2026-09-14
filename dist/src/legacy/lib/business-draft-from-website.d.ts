export type BusinessLocationDraft = {
    locationName: string;
    city: string;
    state: string;
    address?: string;
};
export type BusinessDraftFromWebsite = {
    website: string;
    businessName: string;
    businessType: string;
    about: string;
    contactEmail: string;
    phone: string;
    city: string;
    state: string;
    locations: BusinessLocationDraft[];
    imageUrls: string[];
    supportsDineAndDonate: boolean;
    supportsShopAndDonate: boolean;
    supportsServiceGiveback: boolean;
    supportsGuestBartending: boolean;
    missingFields: string[];
    confirmationStatus: "AI Draft" | string;
    provider: string;
};
export declare function generateBusinessDraftFromWebsite(websiteInput: string): Promise<BusinessDraftFromWebsite>;
