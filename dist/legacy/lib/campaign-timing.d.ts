import type { MethodType } from "../types/campaign";
export declare const BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
export declare const LIMITED_PROMOTION_LEAD_DAYS = 21;
export declare const TIGHT_TIMELINE_MIN_DAYS = 8;
export declare const FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = 21;
export declare const AMBASSADOR_RECOMMENDED_DAYS = 14;
export type TimingStatus = "ok" | "needs_forkup_review" | "limited_promotion_window" | "tight_timeline" | "too_soon";
export type TimingCta = "change_date" | "continue_without_business_method" | "confirm_business" | "submit_for_forkup_review";
export type MethodTimingEvaluation = {
    status: TimingStatus;
    message: string | null;
    ctas: TimingCta[];
    daysUntilAnchor: number | null;
    anchorDate: string | null;
    anchorKind: "start" | "event" | "end" | null;
};
export type BusinessConfirmationInput = {
    confirmedBusinessName?: string | null;
    confirmedContactName?: string | null;
    confirmedContactEmail?: string | null;
    confirmedMethod?: string | null;
    confirmedStatus?: string | null;
    confirmedNotes?: string | null;
};
export declare function daysUntil(dateStr: string | null | undefined): number | null;
export declare function hasBusinessMethods(methods: MethodType[]): boolean;
export declare function hasGivebackMethods(methods: MethodType[]): boolean;
export declare function hasGuestBartending(methods: MethodType[]): boolean;
export declare function hasDefaultFundraisingLayer(methods: MethodType[]): boolean;
export declare function timingBandFromDays(days: number): TimingStatus;
export declare function isBusinessConfirmationComplete(input: BusinessConfirmationInput | null | undefined): boolean;
export declare function validateBusinessConfirmation(input: BusinessConfirmationInput | null | undefined): string | null;
export declare function hasAnyBusinessConfirmationField(input: BusinessConfirmationInput | null | undefined): boolean;
export declare function allowsBusinessInviteEmails(status: string | null | undefined, opts?: {
    businessConfirmed?: boolean;
    forkupReviewStatus?: string | null;
}): boolean;
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
