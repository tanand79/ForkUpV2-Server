import { type JoinDoorType } from "./join-door-type";
import { type VenuePageCopy } from "./venue-page-extract";
export type FindBusinessChecks = {
    websiteFound: boolean;
    logoFound: boolean;
    photosFound: boolean;
    locationFound: boolean;
};
export type FindBusinessFromNameResult = {
    businessName: string;
    website: string;
    businessType: string;
    about: string;
    contactEmail: string;
    phone: string;
    city: string;
    state: string;
    address: string;
    zip: string;
    locations: Array<{
        locationName: string;
        city: string;
        state: string;
        address?: string;
        reservationUrl?: string;
    }>;
    reservationUrl: string | null;
    bookingPlatform: string | null;
    logoUrl: string | null;
    imageUrls: string[];
    discountHours: VenuePageCopy["discountHours"] | null;
    eligibleWindow: string;
    checks: FindBusinessChecks;
    locationSourceUrl: string | null;
    joinDoorType: JoinDoorType | null;
    confirmationStatus: string;
    provider: string;
};
export declare function findBusinessFromName(input: {
    businessName: string;
    joinDoorType?: unknown;
}): Promise<FindBusinessFromNameResult>;
