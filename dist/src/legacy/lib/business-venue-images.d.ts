export declare function scrapeBusinessVenueImages(input: {
    websiteUrl: string;
    reservationUrl?: string | null;
    limit?: number;
}): Promise<string[]>;
