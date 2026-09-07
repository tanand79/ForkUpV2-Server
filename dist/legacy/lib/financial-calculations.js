"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CARD_FEE_FIXED = exports.DEFAULT_CARD_FEE_PERCENT = exports.DEFAULT_PLATFORM_FEE_PERCENT = void 0;
exports.calculateDonationPool = calculateDonationPool;
exports.calculatePlatformFee = calculatePlatformFee;
exports.calculateGivebackBreakdown = calculateGivebackBreakdown;
exports.roundMoney = roundMoney;
exports.normalizePlatformFeePercent = normalizePlatformFeePercent;
exports.normalizeCardFeePercent = normalizeCardFeePercent;
exports.buildSettlementCalculationLines = buildSettlementCalculationLines;
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
function normalizePlatformFeePercent(value, fallback = exports.DEFAULT_PLATFORM_FEE_PERCENT) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
        return fallback;
    }
    const n = Number(value);
    return n > 1 ? n : roundMoney(n * 100);
}
function normalizeCardFeePercent(value, fallback = exports.DEFAULT_CARD_FEE_PERCENT) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
        return fallback;
    }
    const n = Number(value);
    return n > 1 ? n : roundMoney(n * 100);
}
function buildSettlementCalculationLines(input) {
    const breakdown = calculateSettlementSnapshot(input);
    const platformPct = input.platformFeePercent;
    const cardPct = input.cardFeePercent ?? exports.DEFAULT_CARD_FEE_PERCENT;
    const cardFixed = input.cardFeeFixed ?? exports.DEFAULT_CARD_FEE_FIXED;
    const count = breakdown.stripeDonationCount;
    const lines = [
        {
            label: "Eligible sales",
            formula: "Sum of approved receipt subtotals",
            amount: breakdown.eligibleSales,
        },
        {
            label: "Gross giveback",
            formula: `Eligible sales × ${breakdown.givebackPercentage}%`,
            amount: breakdown.grossGiveback,
        },
        {
            label: "ForkUp platform fee",
            formula: `Gross giveback × ${platformPct}% (does not apply to online donations)`,
            amount: breakdown.forkupFee,
        },
        {
            label: "Net from business giveback",
            formula: "Gross giveback − ForkUp fee",
            amount: breakdown.netFromGiveback,
        },
        {
            label: "ACH debit (business owes ForkUp)",
            formula: "Equals ForkUp platform fee",
            amount: breakdown.achDebitAmount,
        },
    ];
    if (breakdown.stripeDonations > 0 || count > 0) {
        lines.push({
            label: "Online donations (gross)",
            formula: "Sum of completed virtual donations",
            amount: breakdown.stripeDonations,
        }, {
            label: "Card processing fee",
            formula: count > 0
                ? `Amount charged × ${cardPct}% + $${cardFixed.toFixed(2)} × ${count} donation(s)`
                : `Amount charged × ${cardPct}%`,
            amount: breakdown.stripeFee,
        }, {
            label: "Online net to nonprofit",
            formula: "Amount charged − card processing fee",
            amount: breakdown.stripeNet,
        });
    }
    lines.push({
        label: "Total net to nonprofit",
        formula: "Net from giveback + online net after card fees",
        amount: breakdown.netNonprofitAmount,
    });
    return { breakdown, lines };
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