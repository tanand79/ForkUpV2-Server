export type NonprofitWebIdentity = {
    status: "found" | "ambiguous" | "not_found";
    name: string;
    website: string | null;
    reason: string;
    provider: "tavily_bedrock" | null;
};
export type NonprofitWebResearchResult = {
    status: "found" | "ambiguous" | "not_found" | "unavailable";
    name: string;
    website: string | null;
    about: string;
    mission: string;
    vision: string;
    location: string;
    address: string;
    facebookUrl: string | null;
    instagramUrl: string | null;
    linkedinUrl: string | null;
    youtubeUrl: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    contactEmailSource?: string | null;
    contactPhoneSource?: string | null;
    imageUrls: string[];
    reason: string;
    warnings: string[];
    provider: "tavily_bedrock" | null;
};
type ResearchPage = {
    url: string;
    title: string;
    text: string;
    images: string[];
};
export declare function nonprofitWebResearchConfigured(): boolean;
export declare function publicUrl(value: string): string | null;
export declare function matchEvidenceWebsite(claimed: string | null | undefined, pages: ResearchPage[]): string | null;
export declare function attributedContact(pages: {
    url: string;
    text: string;
}[], website: string | null, email: string | null, phone: string | null): {
    email: string | null;
    emailSource: string | null;
    phone: string | null;
    phoneSource: string | null;
};
export declare function discoverNonprofitWebsite(params: {
    organizationName: string;
    ein?: string | null;
    city?: string | null;
    state?: string | null;
    signal?: AbortSignal;
}): Promise<NonprofitWebIdentity>;
export declare function researchNonprofitProfile(params: {
    organizationName: string;
    ein?: string | null;
    city?: string | null;
    state?: string | null;
    signal?: AbortSignal;
}): Promise<NonprofitWebResearchResult>;
export {};
