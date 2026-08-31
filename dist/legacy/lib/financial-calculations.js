"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CARD_FEE_FIXED = exports.DEFAULT_CARD_FEE_PERCENT = exports.DEFAULT_PLATFORM_FEE_PERCENT = void 0;
exports.calculateDonationPool = calculateDonationPool;
exports.calculatePlatformFee = calculatePlatformFee;
exports.calculateGivebackBreakdown = calculateGivebackBreakdown;
exports.roundMoney = roundMoney;
exports.calculateCardProcessingFee = calculateCardProcessingFee;
exports.calculateSettlementSnapshot = calculateSettlementSnapshot;
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
exports.DEFAULT_CARD_FEE_PERCENT = 2.9;
exports.DEFAULT_CARD_FEE_FIXED = 0.3;
function roundMoney(value) {
    return Math.round(value * 100) / 100;
}
function calculateCardProcessingFee(amountCharged, donationCount, percent = exports.DEFAULT_CARD_FEE_PERCENT, fixedFee = exports.DEFAULT_CARD_FEE_FIXED) {
    if (donationCount <= 0 || amountCharged <= 0)
        return 0;
    return roundMoney(amountCharged * (percent / 100) + fixedFee * donationCount);
}
function calculateSettlementSnapshot(input) {
    const eligibleSales = Number(input.eligibleSales) || 0;
    const givebackPercentage = Number(input.givebackPercentage) || 0;
    const platformFeePercent = input.platformFeePercent ?? exports.DEFAULT_PLATFORM_FEE_PERCENT;
    const stripeDonations = Number(input.stripeDonations) || 0;
    const stripeAmountCharged = Number(input.stripeAmountCharged) || stripeDonations;
    const stripeDonationCount = Number(input.stripeDonationCount) || 0;
    const grossGiveback = calculateDonationPool(eligibleSales, givebackPercentage);
    const forkupFee = calculatePlatformFee(grossGiveback, platformFeePercent);
    const netFromGiveback = roundMoney(grossGiveback - forkupFee);
    const stripeFee = calculateCardProcessingFee(stripeAmountCharged, stripeDonationCount, input.cardFeePercent, input.cardFeeFixed);
    const stripeNet = roundMoney(stripeAmountCharged - stripeFee);
    const donationPool = roundMoney(grossGiveback + stripeDonations);
    const netNonprofitAmount = roundMoney(netFromGiveback + stripeNet);
    return {
        eligibleSales,
        givebackPercentage,
        grossGiveback,
        platformFeePercent,
        forkupFee,
        netFromGiveback,
        stripeDonations,
        stripeAmountCharged,
        stripeDonationCount,
        stripeFee,
        stripeNet,
        donationPool,
        netNonprofitAmount,
        achDebitAmount: forkupFee,
    };
}
//# sourceMappingURL=financial-calculations.js.map