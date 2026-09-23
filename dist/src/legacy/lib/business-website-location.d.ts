export type BusinessLocationHints = {
    address: string;
    city: string;
    state: string;
    zip: string;
    pageText: string;
    aboutHint: string;
    hoursText: string;
    sourceUrl: string | null;
    websiteFound: boolean;
    reservationUrl: string | null;
    bookingPlatform: string | null;
    bookingLabel: string | null;
};
export declare function scrapeBusinessLocationHints(websiteInput: string): Promise<BusinessLocationHints>;
export declare function isEmptyLocationValue(raw: string | null | undefined): boolean;
