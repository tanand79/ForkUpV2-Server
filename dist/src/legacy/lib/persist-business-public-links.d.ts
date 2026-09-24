export type BusinessPublicLinks = {
    website?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    tiktokUrl?: string | null;
    youtubeUrl?: string | null;
    phone?: string | null;
    venueEmail?: string | null;
};
export declare function persistBusinessPublicLinks(businessId: number, links: BusinessPublicLinks): Promise<void>;
export type BusinessPublicLinksUpdate = {
    website?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    tiktokUrl?: string | null;
    phone?: string | null;
    venueEmail?: string | null;
};
export declare function updateBusinessPublicLinks(businessId: number, links: BusinessPublicLinksUpdate): Promise<BusinessPublicLinksUpdate | null>;
export declare function persistBusinessGalleryUrls(businessId: number, urls: string[]): Promise<void>;
export declare function mergeBusinessGalleryUrls(businessId: number, urls: string[]): Promise<string[]>;
export declare function persistBusinessVenueCoverUrl(businessId: number, coverUrl: string | null | undefined): Promise<string | null>;
