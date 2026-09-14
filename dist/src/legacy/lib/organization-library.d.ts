export type LibraryOrgType = "nonprofit" | "business";
export type ApprovedLibraryItem = {
    category: string;
    title: string | null;
    content: string | null;
    sourceUrl: string | null;
    assetUrl: string | null;
};
export declare function fetchApprovedLibraryItems(orgType: LibraryOrgType, orgId: number): Promise<ApprovedLibraryItem[]>;
export declare function buildLibraryContext(items: ApprovedLibraryItem[]): string;
export declare function pickLaunchSnippet(items: ApprovedLibraryItem[]): string | null;
export declare function pickImpactSnippet(items: ApprovedLibraryItem[]): string | null;
export declare function pickPromotionChannels(items: ApprovedLibraryItem[]): {
    facebookUrl: string;
    instagramHandle: string;
    websiteUrl: string;
};
export declare function pickFeaturedImage(items: ApprovedLibraryItem[]): string | null;
