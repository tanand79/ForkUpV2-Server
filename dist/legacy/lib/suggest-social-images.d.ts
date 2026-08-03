export type SuggestedImageSource = "website" | "facebook" | "instagram" | "social_suggest";
export interface SuggestedImage {
    url: string;
    source: SuggestedImageSource;
    sourceUrl: string | null;
}
export declare function looksLikeLogoUrl(url: string): boolean;
export declare function photoCoverRank(url: string): number;
export declare function normalizeInstagramUrl(handleOrUrl: string): string | null;
export declare function normalizeFacebookUrl(url: string): string | null;
export declare function normalizeWebsiteUrl(url: string): string | null;
export declare function extractImageUrlsFromHtml(html: string, pageUrl: string): string[];
export declare function suggestSocialImages(input: {
    facebookUrl?: string;
    instagramHandle?: string;
    websiteUrl?: string;
    limit?: number;
}): Promise<SuggestedImage[]>;
