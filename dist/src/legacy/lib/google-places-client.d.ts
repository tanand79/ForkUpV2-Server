export type GooglePlaceIdentity = {
    placeId: string;
    name: string;
    website: string | null;
    phone: string | null;
    formattedAddress: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    photoNames: string[];
    provider: "google_places";
};
export declare function googlePlacesConfigured(): boolean;
export declare function searchGooglePlace(params: {
    businessName: string;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    signal?: AbortSignal;
}): Promise<GooglePlaceIdentity | null>;
