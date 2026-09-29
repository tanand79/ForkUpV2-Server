export type BusinessPublicLinks = {
    website?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    tiktokUrl?: string | null;
    youtubeUrl?: string | null;
    phone?: string | null;
    venueEmail?: string | null;
    description?: string | null;
    discountHours?: Record<string, string> | null;
    eligibleWindow?: string | null;
};
export declare const VENUE_DISCOUNT_DAYS: readonly ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export type VenueDiscountHoursMap = Record<(typeof VENUE_DISCOUNT_DAYS)[number], string>;
export declare function defaultVenueDiscountHours(): VenueDiscountHoursMap;
export declare function normalizeVenueDiscountHours(value: unknown): VenueDiscountHoursMap;
export declare function venueDiscountHoursHaveOpenDay(hours: VenueDiscountHoursMap): boolean;
export declare function persistVenueDiscountHours(businessId: number, hours: Record<string, string> | null | undefined, eligibleWindow?: string | null, options?: {
    overwrite?: boolean;
    markResolved?: boolean;
}): Promise<void>;
export declare function persistPrimaryBusinessLocationDetails(businessId: number, loc: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
}): Promise<void>;
export declare function updatePrimaryBusinessLocationDetails(businessId: number, loc: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
}): Promise<void>;
export declare function persistBusinessPublicLinks(businessId: number, links: BusinessPublicLinks): Promise<void>;
export type BusinessPublicLinksUpdate = {
    businessName?: string | null;
    website?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    tiktokUrl?: string | null;
    phone?: string | null;
    venueEmail?: string | null;
    description?: string | null;
    discountHours?: Record<string, string> | null;
    eligibleWindow?: string | null;
};
export declare function updateBusinessPublicLinks(businessId: number, links: BusinessPublicLinksUpdate): Promise<BusinessPublicLinksUpdate | null>;
export declare function persistBusinessGalleryUrls(businessId: number, urls: string[]): Promise<string[]>;
export declare function replaceBusinessGalleryUrls(businessId: number, urls: string[]): Promise<string[]>;
export declare function mergeBusinessGalleryUrls(businessId: number, urls: string[]): Promise<string[]>;
export declare function persistBusinessVenueCoverUrl(businessId: number, coverUrl: string | null | undefined): Promise<string | null>;
