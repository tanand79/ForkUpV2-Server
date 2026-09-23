export type SuggestedImageSource = "website" | "facebook" | "instagram" | "social_suggest";
export interface SuggestedImage {
    url: string;
    source: SuggestedImageSource;
    sourceUrl: string | null;
    caption?: string | null;
}
export declare function looksLikeLogoUrl(url: string): boolean;
export declare function looksLikeDecorativeAssetUrl(url: string): boolean;
export declare function photoCoverRank(url: string): number;
export declare function normalizeInstagramUrl(handleOrUrl: string): string | null;
export declare function normalizeFacebookUrl(url: string): string | null;
export declare function normalizeLinkedInUrl(url: string): string | null;
export declare function normalizeYouTubeUrl(url: string): string | null;
export declare function normalizeWebsiteUrl(url: string): string | null;
export declare function extractImageUrlsFromHtml(html: string, pageUrl: string): string[];
export declare function extractSocialLinksFromHtml(html: string): {
    facebookUrl: string | null;
    instagramUrl: string | null;
    linkedinUrl: string | null;
    youtubeUrl: string | null;
};
export declare function discoverSocialLinksFromWebsite(websiteUrl: string): Promise<{
    facebookUrl: string | null;
    instagramUrl: string | null;
    linkedinUrl: string | null;
    youtubeUrl: string | null;
}>;
export declare function suggestSocialImages(input: {
    facebookUrl?: string;
    instagramHandle?: string;
    websiteUrl?: string;
    linkedinUrl?: string;
    youtubeUrl?: string;
    limit?: number;
}): Promise<SuggestedImage[]>;
