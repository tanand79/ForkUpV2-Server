export type BookingPlatformLink = {
    platform: string;
    label: string;
    url: string;
};
export declare function classifyBookingPlatformUrl(raw: string): BookingPlatformLink | null;
export declare function extractBookingPlatformLink(html: string): BookingPlatformLink | null;
