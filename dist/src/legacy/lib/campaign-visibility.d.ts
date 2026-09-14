import type { MethodType } from "../types/campaign";
export type VisibilityTrackStatus = "not_selected" | "ready" | "waiting_on_business_acceptance" | "event_details_needed" | "payment_setup_needed" | "pending_setup" | "needs_forkup_review" | "limited_promotion_window" | "tight_timeline" | "too_soon";
export type VisibilityTrack = {
    id: string;
    label: string;
    status: VisibilityTrackStatus;
    display: string;
};
export type NextSuccessEngineAction = {
    id: number;
    title: string;
    scheduledDate: string | null;
    actionType: string;
} | null;
export type CampaignVisibility = {
    tracks: VisibilityTrack[];
    ready: string[];
    pending: string[];
    needsForkupReview: string[];
    needsBusinessAction: string[];
    nextSuccessEngineAction: NextSuccessEngineAction;
};
export type VisibilityPartner = {
    businessName: string;
    acceptanceStatus: string;
    inviteStatus?: string | null;
    respondByDate?: string | null;
    setupStatus?: string | null;
    settlementReadyStatus?: string | null;
};
export declare function buildCampaignVisibility(input: {
    methods: MethodType[];
    campaignStatus: string;
    businessTimingStatus?: string | null;
    forkupReviewStatus?: string | null;
    eventDate?: string | null;
    endDate?: string | null;
    coverPresent?: boolean;
    storyPresent?: boolean;
    partners: VisibilityPartner[];
    nextSuccessEngineAction?: NextSuccessEngineAction;
}): CampaignVisibility;
