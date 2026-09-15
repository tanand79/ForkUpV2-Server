export type CompleteStripeDonationResult = {
    found: boolean;
    completed: boolean;
    donationId?: number;
    amount?: number;
    campaignId?: number;
    alreadyCompleted?: boolean;
};
export declare function completeStripeDonationBySession(sessionId: string, paymentIntentId: string | null): Promise<CompleteStripeDonationResult>;
