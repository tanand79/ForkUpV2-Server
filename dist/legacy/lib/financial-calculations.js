"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PLATFORM_FEE_PERCENT = void 0;
exports.calculateDonationPool = calculateDonationPool;
exports.calculatePlatformFee = calculatePlatformFee;
exports.calculateGivebackBreakdown = calculateGivebackBreakdown;
exports.DEFAULT_PLATFORM_FEE_PERCENT = 15;
function calculateDonationPool(eligibleSubtotal, givebackPercentage) {
    return Math.round(eligibleSubtotal * (givebackPercentage / 100) * 100) / 100;
}
function calculatePlatformFee(donationPool, platformFeePercent = exports.DEFAULT_PLATFORM_FEE_PERCENT) {
    return Math.round(donationPool * (platformFeePercent / 100) * 100) / 100;
}
function calculateGivebackBreakdown(eligibleSales, givebackPercentage, platformFeePercent = exports.DEFAULT_PLATFORM_FEE_PERCENT) {
    const donationPool = calculateDonationPool(eligibleSales, givebackPercentage);
    const platformFee = calculatePlatformFee(donationPool, platformFeePercent);
    const netNonprofitAmount = Math.round((donationPool - platformFee) * 100) / 100;
    return {
        eligibleSales,
        givebackPercentage,
        donationPool,
        platformFee,
        netNonprofitAmount,
    };
}
//# sourceMappingURL=financial-calculations.js.map