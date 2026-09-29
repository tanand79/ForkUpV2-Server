export declare function isDurableCampaignImageUrl(url: string): boolean;
export declare function normalizeDurableCampaignImageUrl(url: string): string;
export declare function detectImageMimeFromBuffer(buffer: Buffer): string | null;
export declare function ensureDurableImageUrl(imageUrl: string, prefix?: string, options?: {
    headers?: Record<string, string>;
    maxBytes?: number;
    minBytes?: number;
}): Promise<string>;
export declare function unwrapVenuePhotoProxyUrl(url: string): string;
export declare function preferPhotoUrlsFirst(urls: string[]): string[];
export declare function ensureDurableVenueGalleryUrls(urls: string[]): Promise<string[]>;
