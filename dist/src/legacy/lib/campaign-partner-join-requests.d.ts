import type { AuthUser } from "./auth";
import type { MethodType } from "../types/campaign";
export type PartnerJoinDoorType = "restaurant" | "local";
export type PartnerJoinRequestDto = {
    id: number;
    campaignId: number;
    campaignSlug: string;
    campaignName: string;
    nonprofitName: string;
    businessId: number;
    businessName: string;
    businessEmail: string | null;
    locationId: number;
    locationName: string;
    city: string | null;
    state: string | null;
    methodId: number;
    methodType: MethodType;
    methodName: string;
    doorType: PartnerJoinDoorType | null;
    requestStatus: "pending" | "accepted" | "declined";
    proposedGivebackPercentage: number | null;
    message: string | null;
    campaignBusinessLocationId: number | null;
    acceptPath: string | null;
    createdAt: string;
    respondedAt: string | null;
};
export declare function userBelongsToBusiness(user: AuthUser, businessId: number): boolean;
export declare function userMayManageCampaignNonprofit(user: AuthUser, campaign: {
    nonprofit_id: number;
    created_by_user_id: number | null;
}): Promise<boolean>;
export declare function createPartnerJoinRequest(input: {
    slug: string;
    user: AuthUser;
    businessId: number;
    locationId?: number;
    methodType?: MethodType;
    doorType?: PartnerJoinDoorType | null;
    message?: string | null;
    proposedGivebackPercentage?: number | null;
}): Promise<{
    ok: true;
    request: PartnerJoinRequestDto;
} | {
    ok: false;
    status: number;
    error: string;
    request?: PartnerJoinRequestDto;
}>;
export declare function listPartnerJoinRequestsForCampaign(slug: string, status?: "pending" | "accepted" | "declined" | "all"): Promise<{
    ok: true;
    requests: PartnerJoinRequestDto[];
} | {
    ok: false;
    status: number;
    error: string;
}>;
export declare function listMyPartnerJoinRequests(input: {
    slug: string;
    user: AuthUser;
    businessId: number;
}): Promise<{
    ok: true;
    requests: PartnerJoinRequestDto[];
} | {
    ok: false;
    status: number;
    error: string;
}>;
export declare function acceptPartnerJoinRequest(input: {
    slug: string;
    requestId: number;
    user: AuthUser;
}): Promise<{
    ok: true;
    request: PartnerJoinRequestDto;
    invitationToken: string;
    acceptPath: string;
} | {
    ok: false;
    status: number;
    error: string;
}>;
export declare function declinePartnerJoinRequest(input: {
    slug: string;
    requestId: number;
    user: AuthUser;
    reason?: string | null;
}): Promise<{
    ok: true;
    request: PartnerJoinRequestDto;
} | {
    ok: false;
    status: number;
    error: string;
}>;
