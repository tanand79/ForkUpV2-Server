import { hasBusinessMethods, hasDefaultFundraisingLayer, hasGivebackMethods, hasGuestBartending, type MethodTimingEvaluation } from "./campaign-timing";
import type { MethodType } from "../types/campaign";
export type InviteReadinessInput = {
    methods: MethodType[];
    startDate?: string | null;
    endDate?: string | null;
    eventDate?: string | null;
    hasStory?: boolean;
    hasCover?: boolean;
    hasNonprofitProfile?: boolean;
    hasBusinessContacts?: boolean;
    invitedBusinessCount?: number;
    timingStatus?: string | null;
};
export type InviteReadinessResult = {
    score: number;
    summary: string;
    factors: {
        label: string;
        points: number;
        note: string;
    }[];
    aiExplanation: string | null;
    provider: string;
};
export type MethodMixResult = {
    recommended: MethodType[];
    summary: string;
    aiExplanation: string | null;
    provider: string;
};
export type TimingGuidanceResult = {
    timing: MethodTimingEvaluation;
    summary: string;
    aiExplanation: string | null;
    provider: string;
};
export declare function scoreInviteReadiness(input: InviteReadinessInput): InviteReadinessResult;
export declare function recommendMethodMix(input: {
    methods?: MethodType[];
    startDate?: string | null;
    eventDate?: string | null;
    endDate?: string | null;
    goal?: number;
}): MethodMixResult;
export declare function buildTimingGuidance(input: {
    methods: MethodType[];
    startDate?: string | null;
    eventDate?: string | null;
    forkupReviewStatus?: string | null;
}): TimingGuidanceResult;
export declare function polishGuidanceWithAi(input: {
    systemHint: string;
    facts: string;
}): Promise<string | null>;
export declare function describeMethods(methods: MethodType[]): string;
export { hasBusinessMethods, hasDefaultFundraisingLayer, hasGivebackMethods, hasGuestBartending, };
