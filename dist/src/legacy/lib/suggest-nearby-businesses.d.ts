import { type JoinDoorType } from "./join-door-type";
export type NearbyBusinessCandidate = {
    businessName: string;
    city: string;
    state: string;
    address: string;
    zip: string;
    website: string;
    businessType: string;
};
export type SuggestNearbyBusinessesResult = {
    nearZip: string;
    city: string | null;
    state: string | null;
    joinDoorType: JoinDoorType | null;
    candidates: NearbyBusinessCandidate[];
    provider: string;
    matchCount: number;
};
export declare function suggestNearbyBusinesses(params: {
    nearZip: string;
    joinDoorType?: unknown;
    city?: string;
    state?: string;
    limit?: unknown;
}): Promise<SuggestNearbyBusinessesResult>;
