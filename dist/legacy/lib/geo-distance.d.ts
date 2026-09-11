export declare const DEFAULT_NEARBY_RADIUS_MILES = 50;
export type LatLng = {
    latitude: number;
    longitude: number;
};
export declare function parseLatLng(latRaw: unknown, lngRaw: unknown): LatLng | null;
export declare function parseRadiusMiles(raw: unknown, defaultMiles?: number): number;
export declare function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number;
export declare function isWithinRadiusMiles(origin: LatLng, targetLat: number, targetLng: number, radiusMiles: number): boolean;
export declare function nearbyKeepDecision(origin: LatLng | null, rowLat: number | null | undefined, rowLng: number | null | undefined, radiusMiles: number, options?: {
    requireCoordinates?: boolean;
}): {
    keep: boolean;
    distanceMiles: number | null;
};
export declare function geocodeUsZip(zipRaw: string): Promise<LatLng | null>;
export type UsZipPlace = LatLng & {
    zip: string;
    city: string | null;
    state: string | null;
};
export declare function resolveUsZip(zipRaw: string): Promise<UsZipPlace | null>;
export declare function geocodeUsCityState(cityRaw: string, stateRaw: string): Promise<LatLng | null>;
export declare function reverseGeocodeUs(latitude: number, longitude: number): Promise<{
    city: string | null;
    state: string | null;
    zip: string | null;
} | null>;
