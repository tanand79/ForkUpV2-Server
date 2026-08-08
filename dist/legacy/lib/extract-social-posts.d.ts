export type SocialPlatform = "instagram" | "facebook" | "linkedin" | "x" | "tiktok" | "youtube" | "unknown";
export type ExtractedSocialPostStatus = "ok" | "private" | "unavailable" | "no_images" | "unsupported";
export type ExtractedSocialPost = {
    platform: SocialPlatform;
    postUrl: string;
    profileUrl: string | null;
    caption: string | null;
    imageUrls: string[];
    status: ExtractedSocialPostStatus;
};
export declare function detectSocialPlatform(url: string): SocialPlatform;
export declare function isLikelySocialPostUrl(url: string, platform?: SocialPlatform): boolean;
export declare function extractInstagramMediaFromHtml(html: string, maxImages: number): string[];
export declare function extractCaptionFromHtml(html: string): string | null;
export declare function discoverPostUrlsFromHtml(profileUrl: string, platform: SocialPlatform, html: string, maxPosts: number): string[];
export declare function extractSingleSocialPost(postUrl: string, profileUrl?: string | null): Promise<ExtractedSocialPost>;
export declare function extractPostsFromProfileUrl(profileUrl: string, maxPosts?: number): Promise<ExtractedSocialPost[]>;
export declare function extractPostsFromSocialProfiles(input: {
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    youtubeUrl?: string | null;
    xUrl?: string | null;
    tiktokUrl?: string | null;
    maxPostsPerProfile?: number;
}): Promise<ExtractedSocialPost[]>;
