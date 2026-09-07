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

/** Engine defaults: Stripe-style card fee on virtual (online) donations. */
export const DEFAULT_CARD_FEE_PERCENT = 2.9;
export const DEFAULT_CARD_FEE_FIXED = 0.3;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalize platform fee from DB/settings — accepts whole percent (15) or decimal (0.15).
 * Matches legacy Settlement Engine: values > 1 are treated as percent points.
 */
export function normalizePlatformFeePercent(
  value: number | null | undefined,
  fallback: number = DEFAULT_PLATFORM_FEE_PERCENT,
): number {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return fallback;
  }
  const n = Number(value);
  return n > 1 ? n : roundMoney(n * 100);
}

/**
 * Normalize card processing percent — accepts 2.9 or 0.029.
 */
export function normalizeCardFeePercent(
  value: number | null | undefined,
  fallback: number = DEFAULT_CARD_FEE_PERCENT,
): number {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return fallback;
  }
  const n = Number(value);
  return n > 1 ? n : roundMoney(n * 100);
}

/**
 * Human-readable settlement math for review screens (Task 14).
 * Inputs: snapshot breakdown fields. Outputs: labeled lines with formulas.
 */
export function buildSettlementCalculationLines(input: {
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
  lines: { label: string; formula: string; amount: number }[];
} {
  const breakdown = calculateSettlementSnapshot(input);
  const platformPct = input.platformFeePercent;
  const cardPct = input.cardFeePercent ?? DEFAULT_CARD_FEE_PERCENT;
  const cardFixed = input.cardFeeFixed ?? DEFAULT_CARD_FEE_FIXED;
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
    lines.push(
      {
        label: "Online donations (gross)",
        formula: "Sum of completed virtual donations",
        amount: breakdown.stripeDonations,
      },
      {
        label: "Card processing fee",
        formula:
          count > 0
            ? `Amount charged × ${cardPct}% + $${cardFixed.toFixed(2)} × ${count} donation(s)`
            : `Amount charged × ${cardPct}%`,
        amount: breakdown.stripeFee,
      },
      {
        label: "Online net to nonprofit",
        formula: "Amount charged − card processing fee",
        amount: breakdown.stripeNet,
      },
    );
  }

  lines.push({
    label: "Total net to nonprofit",
    formula: "Net from giveback + online net after card fees",
    amount: breakdown.netNonprofitAmount,
  });

  return { breakdown, lines };
}

/**
 * Card processing fee: percent of amount charged + fixed fee per completed donation.
 * Matches ForkUpSettlementEngine (2.9% + $0.30).
 */
export function calculateCardProcessingFee(
  amountCharged: number,
  donationCount: number,
  percent: number = DEFAULT_CARD_FEE_PERCENT,
  fixedFee: number = DEFAULT_CARD_FEE_FIXED,
): number {
  if (donationCount <= 0 || amountCharged <= 0) return 0;
  return roundMoney(amountCharged * (percent / 100) + fixedFee * donationCount);
}

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

/**
 * Immutable snapshot math from the ASP.NET Settlement Engine:
 * - Gross giveback = eligible sales × giveback%
 * - ForkUp fee applies to giveback only (default 15%)
 * - Virtual donations are added to the pool; card fees reduce nonprofit net
 * - ACH debit = ForkUp fee (business → platform)
 */
export function calculateSettlementSnapshot(input: {
  eligibleSales: number;
  givebackPercentage: number;
  platformFeePercent?: number;
  stripeDonations?: number;
  stripeAmountCharged?: number;
  stripeDonationCount?: number;
  cardFeePercent?: number;
  cardFeeFixed?: number;
}): SettlementSnapshotBreakdown {
  const eligibleSales = Number(input.eligibleSales) || 0;
  const givebackPercentage = Number(input.givebackPercentage) || 0;
  const platformFeePercent =
    input.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT;
  const stripeDonations = Number(input.stripeDonations) || 0;
  const stripeAmountCharged =
    Number(input.stripeAmountCharged) || stripeDonations;
  const stripeDonationCount = Number(input.stripeDonationCount) || 0;

  const grossGiveback = calculateDonationPool(eligibleSales, givebackPercentage);
  const forkupFee = calculatePlatformFee(grossGiveback, platformFeePercent);
  const netFromGiveback = roundMoney(grossGiveback - forkupFee);
  const stripeFee = calculateCardProcessingFee(
    stripeAmountCharged,
    stripeDonationCount,
    input.cardFeePercent,
    input.cardFeeFixed,
  );
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
