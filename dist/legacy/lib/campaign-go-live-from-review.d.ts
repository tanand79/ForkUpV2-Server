export type PromoteFromReviewResult = {
    campaignId: number;
    slug: string;
    campaignStatus: string;
    forkupReviewStatus: string;
    businessTimingStatus: string;
    emailSent: boolean;
};
export declare function promoteCampaignAfterForkupApproval(slug: string): Promise<PromoteFromReviewResult | null>;
