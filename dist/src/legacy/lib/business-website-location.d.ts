export type BusinessLocationHints = {
    address: string;
    city: string;
    state: string;
    zip: string;
    pageText: string;
    sourceUrl: string | null;
    websiteFound: boolean;
};
export declare function scrapeBusinessLocationHints(websiteInput: string): Promise<BusinessLocationHints>;
export declare function isEmptyLocationValue(raw: string | null | undefined): boolean;
