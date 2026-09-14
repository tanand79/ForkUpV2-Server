export declare const DEFAULT_PLATFORM_FEE_PERCENT = 15;
export interface GivebackFinancialBreakdown {
    eligibleSales: number;
    givebackPercentage: number;
    donationPool: number;
    platformFee: number;
    netNonprofitAmount: number;
}
export declare function calculateDonationPool(eligibleSubtotal: number, givebackPercentage: number): number;
export declare function calculatePlatformFee(donationPool: number, platformFeePercent?: number): number;
export declare function calculateGivebackBreakdown(eligibleSales: number, givebackPercentage: number, platformFeePercent?: number): GivebackFinancialBreakdown;
export declare const DEFAULT_CARD_FEE_PERCENT = 2.9;
export declare const DEFAULT_CARD_FEE_FIXED = 0.3;
export declare function roundMoney(value: number): number;
export declare function normalizePlatformFeePercent(value: number | null | undefined, fallback?: number): number;
export declare function normalizeCardFeePercent(value: number | null | undefined, fallback?: number): number;
export declare function buildSettlementCalculationLines(input: {
    eligibleSales: number;
    givebackPercentage: number;
    platformFeePercent: number;
    stripeDonations?: number;
    stripeAmountCharged?: number;
    stripeDonationCount?: number;
    cardFeePercent?: number;
    cardFeeFixed?: number;
}): {
    breakdown: SettlementSnapshotBreakdown;
    lines: {
        label: string;
        formula: string;
        amount: number;
    }[];
};
export declare function calculateCardProcessingFee(amountCharged: number, donationCount: number, percent?: number, fixedFee?: number): number;
export interface SettlementSnapshotBreakdown {
    eligibleSales: number;
    givebackPercentage: number;
    grossGiveback: number;
    platformFeePercent: number;
    forkupFee: number;
    netFromGiveback: number;
    stripeDonations: number;
    stripeAmountCharged: number;
    stripeDonationCount: number;
    stripeFee: number;
    stripeNet: number;
    donationPool: number;
    netNonprofitAmount: number;
    achDebitAmount: number;
}
export declare function calculateSettlementSnapshot(input: {
    eligibleSales: number;
    givebackPercentage: number;
    platformFeePercent?: number;
    stripeDonations?: number;
    stripeAmountCharged?: number;
    stripeDonationCount?: number;
    cardFeePercent?: number;
    cardFeeFixed?: number;
}): SettlementSnapshotBreakdown;
