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
