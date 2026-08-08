export type GuessedNonprofitSocial = {
    facebookUrl: string | null;
    instagramUrl: string | null;
    linkedinUrl: string | null;
    youtubeUrl: string | null;
    provider: string | null;
};
export declare function guessNonprofitSocialLinks(params: {
    organizationName: string;
    ein?: string | null;
    city?: string | null;
    state?: string | null;
}): Promise<GuessedNonprofitSocial>;
