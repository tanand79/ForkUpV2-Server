import type { MethodType } from "../types/campaign";
export declare const BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
export declare const FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = 21;
export declare const AMBASSADOR_RECOMMENDED_DAYS = 14;
export type TimingStatus = "ok" | "needs_forkup_review" | "limited_promotion_window";
export type TimingCta = "change_date" | "continue_without_business_method" | "submit_for_forkup_review";
export type MethodTimingEvaluation = {
    status: TimingStatus;
    message: string | null;
    ctas: TimingCta[];
    daysUntilAnchor: number | null;
    anchorDate: string | null;
    anchorKind: "start" | "event" | "end" | null;
};
export declare function daysUntil(dateStr: string | null | undefined): number | null;
export declare function hasBusinessMethods(methods: MethodType[]): boolean;
export declare function hasGivebackMethods(methods: MethodType[]): boolean;
export declare function hasGuestBartending(methods: MethodType[]): boolean;
export declare function hasDefaultFundraisingLayer(methods: MethodType[]): boolean;
export declare function validateMethodDateRequirements(input: {
    methods: MethodType[];
    startDate?: string | null;
    endDate?: string | null;
    eventDate?: string | null;
}): string | null;
export declare function evaluateBusinessMethodTiming(input: {
    methods: MethodType[];
    startDate?: string | null;
    eventDate?: string | null;
    forkupReviewStatus?: string | null;
}): MethodTimingEvaluation;
export declare function evaluateAcceptancePromotionWindow(input: {
    startOrEventDate?: string | null;
}): TimingStatus;
export declare function ambassadorTimingCoachMessage(endDate?: string | null): string | null;
