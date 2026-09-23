declare const DAYS: readonly ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export type VenueWeekday = (typeof DAYS)[number];
export type VenuePageCopy = {
    about: string;
    discountHours: Record<VenueWeekday, string>;
    eligibleWindow: string;
};
export declare function parseHoursFromText(raw: string): Record<VenueWeekday, string>;
export declare function extractVenueCopyFromPage(pageText: string, hints?: {
    aboutHint?: string;
    hoursText?: string;
}): Promise<VenuePageCopy | null>;
export {};
