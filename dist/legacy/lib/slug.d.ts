export declare function slugify(text: string): string;
export declare function uniqueCampaignSlug(baseName: string, exists: (slug: string) => Promise<boolean>): Promise<string>;
