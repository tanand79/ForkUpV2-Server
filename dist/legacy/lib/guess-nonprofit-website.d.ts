export declare function guessNonprofitWebsite(params: {
    organizationName: string;
    ein?: string | null;
    city?: string | null;
    state?: string | null;
}): Promise<{
    website: string | null;
    provider: string | null;
}>;
