export type IdentityMatchTier = "exact" | "near" | "partial" | "weak" | "reject";
export type WebsiteVerifyResult = {
    ok: boolean;
    website: string | null;
    confidence: "high" | "medium" | "low";
    reason: string;
    pageTitle: string | null;
    pageDescription: string | null;
};
export type PageIdentitySignals = {
    title: string;
    description: string;
    siteName: string;
    textSample: string;
};
export declare function normalizeOrgName(raw: string): string;
export declare function orgNameTokens(raw: string): string[];
export declare function identityTokens(raw: string): string[];
export declare function scoreOrgNameMatch(queryName: string, candidateName: string): {
    tier: IdentityMatchTier;
    score: number;
};
export declare function namesReferToSameOrg(queryName: string, candidateName: string): boolean;
export declare function identityTierRank(tier: IdentityMatchTier): number;
export declare function filterByOrgIdentityMatch<T extends {
    organizationName: string;
}>(query: string, candidates: T[]): Array<T & {
    identityMatch: IdentityMatchTier;
    identityScore: number;
}>;
export declare function isRejectedDirectoryHost(url: string): boolean;
export declare function isUnsafeFetchUrl(raw: string): boolean;
export declare function safeRedirectTarget(current: string, location: string): string | null;
export declare function extractPageIdentitySignals(html: string): PageIdentitySignals;
export declare function decideWebsiteIdentity(params: {
    organizationName: string;
    website: string;
    signals: PageIdentitySignals;
}): {
    ok: boolean;
    confidence: "high" | "medium" | "low";
    reason: string;
};
export declare function evidenceMatchesOrganization(organizationName: string, title: string, url: string): boolean;
export declare function socialProfileMatchesOrg(organizationName: string, url: string, title?: string): boolean;
export type TrustedIrsIdentity = {
    organizationName: string;
    ein: string | null;
    website: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
};
export declare function mergeKeepingTrustedIrs<T extends TrustedIrsIdentity>(irs: T, candidate: {
    organizationName: string;
    ein?: string | null;
    website?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    identityTier: IdentityMatchTier;
}): T;
export declare function verifyWebsiteBelongsToOrg(params: {
    organizationName: string;
    website: string;
    city?: string | null;
    state?: string | null;
}): Promise<WebsiteVerifyResult>;
