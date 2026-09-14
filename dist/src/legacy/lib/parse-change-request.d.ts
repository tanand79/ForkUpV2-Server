export type ParsedChangeRequest = {
    preferredDate: string | null;
    preferredGiveback: number | null;
    message: string | null;
};
export declare function parseChangeRequestMessage(raw: string | null | undefined): ParsedChangeRequest;
export declare function shiftCampaignDates(newStart: string, currentStart: string | null | undefined, currentEnd: string | null | undefined): {
    startDate: string;
    endDate: string | null;
};
