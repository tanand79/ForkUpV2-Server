/**
 * Shared financial calculation rules for giveback / settlement.
 * Keeps eligible sales, donation pool, platform fee, and net nonprofit
 * amounts separate and configurable.
 *
 * TODO: Load platform fee from campaign or platform settings when finalized.
 */

export const DEFAULT_PLATFORM_FEE_PERCENT = 15;

export interface GivebackFinancialBreakdown {
  eligibleSales: number;
  givebackPercentage: number;
  donationPool: number;
  platformFee: number;
  netNonprofitAmount: number;
}

export function calculateDonationPool(
  eligibleSubtotal: number,
  givebackPercentage: number,
): number {
  return Math.round(eligibleSubtotal * (givebackPercentage / 100) * 100) / 100;
}

export function calculatePlatformFee(
  donationPool: number,
  platformFeePercent: number = DEFAULT_PLATFORM_FEE_PERCENT,
): number {
  return Math.round(donationPool * (platformFeePercent / 100) * 100) / 100;
}

export function calculateGivebackBreakdown(
  eligibleSales: number,
  givebackPercentage: number,
  platformFeePercent: number = DEFAULT_PLATFORM_FEE_PERCENT,
): GivebackFinancialBreakdown {
  const donationPool = calculateDonationPool(eligibleSales, givebackPercentage);
  const platformFee = calculatePlatformFee(donationPool, platformFeePercent);
  const netNonprofitAmount =
    Math.round((donationPool - platformFee) * 100) / 100;

  return {
    eligibleSales,
    givebackPercentage,
    donationPool,
    platformFee,
    netNonprofitAmount,
  };
}
