export type UsNonprofitSuggestion = {
    id: number;
    organizationName: string;
    slug: string;
    mission: string | null;
    website: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    causeCategory: string | null;
    ein: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    verificationStatus: string;
    claimStatus: string;
    profileStatus: string;
    verified: boolean;
    matchStrength: "strong" | "partial" | "weak";
    source: "irs_us";
    logoUrl: string | null;
};
export type UsNonprofitEnrichment = {
    ein: string;
    organizationName: string | null;
    website: string | null;
    logoUrl: string | null;
    mission: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    providers: string[];
};
export type EnrichUsNonprofitOptions = {
    ein: string;
    organizationName?: string;
    city?: string;
    state?: string;
};
export declare function enrichUsNonprofitByEin(einRaw: string, options?: Omit<EnrichUsNonprofitOptions, "ein">): Promise<UsNonprofitEnrichment | null>;
export type UsNonprofitSuggestParams = {
    q: string;
    state?: string;
    limit?: number;
};
export declare function suggestUsNonprofits(params: UsNonprofitSuggestParams): Promise<{
    candidates: UsNonprofitSuggestion[];
    totalResults: number;
    provider: string;
}>;
