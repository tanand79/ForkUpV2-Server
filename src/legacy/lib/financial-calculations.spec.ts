import {
  buildSettlementCalculationLines,
  calculateCardProcessingFee,
  calculateGivebackBreakdown,
  calculateSettlementSnapshot,
  normalizePlatformFeePercent,
} from "./financial-calculations";

describe("financial-calculations", () => {
  describe("calculateGivebackBreakdown", () => {
    it("computes $2,000 sales at 15% giveback with 15% platform fee", () => {
      const b = calculateGivebackBreakdown(2000, 15, 15);
      expect(b.donationPool).toBe(300);
      expect(b.platformFee).toBe(45);
      expect(b.netNonprofitAmount).toBe(255);
    });
  });

  describe("calculateCardProcessingFee", () => {
    it("computes $1.75 fee on a $50 donation (2.9% + $0.30) — net $48.25", () => {
      const fee = calculateCardProcessingFee(50, 1, 2.9, 0.3);
      expect(fee).toBe(1.75);
      expect(50 - fee).toBe(48.25);
    });

    it("sums fixed fee per donation when multiple charges", () => {
      const fee = calculateCardProcessingFee(100, 2, 2.9, 0.3);
      expect(fee).toBe(3.5); // 2.90 + 0.60
    });
  });

  describe("calculateSettlementSnapshot", () => {
    it("applies platform fee to giveback only, not stripe donations", () => {
      const s = calculateSettlementSnapshot({
        eligibleSales: 1000,
        givebackPercentage: 10,
        platformFeePercent: 15,
        stripeDonations: 50,
        stripeAmountCharged: 50,
        stripeDonationCount: 1,
      });
      expect(s.grossGiveback).toBe(100);
      expect(s.forkupFee).toBe(15);
      expect(s.stripeFee).toBe(1.75);
      expect(s.stripeNet).toBe(48.25);
      expect(s.netNonprofitAmount).toBe(133.25); // 85 + 48.25
      expect(s.achDebitAmount).toBe(15);
    });

    it("online-only campaign: $50 donation nets $48.25 with zero ForkUp fee", () => {
      const s = calculateSettlementSnapshot({
        eligibleSales: 0,
        givebackPercentage: 0,
        stripeDonations: 50,
        stripeAmountCharged: 50,
        stripeDonationCount: 1,
      });
      expect(s.forkupFee).toBe(0);
      expect(s.stripeFee).toBe(1.75);
      expect(s.netNonprofitAmount).toBe(48.25);
    });
  });

  describe("normalizePlatformFeePercent", () => {
    it("accepts whole percent and decimal fraction", () => {
      expect(normalizePlatformFeePercent(15)).toBe(15);
      expect(normalizePlatformFeePercent(0.15)).toBe(15);
    });
  });

  describe("buildSettlementCalculationLines", () => {
    it("documents the $48.25 online donation example from the meeting", () => {
      const { lines } = buildSettlementCalculationLines({
        eligibleSales: 0,
        givebackPercentage: 0,
        platformFeePercent: 15,
        stripeDonations: 50,
        stripeAmountCharged: 50,
        stripeDonationCount: 1,
      });
      const onlineNet = lines.find((l) => l.label === "Online net to nonprofit");
      expect(onlineNet?.amount).toBe(48.25);
      const cardLine = lines.find((l) => l.label === "Card processing fee");
      expect(cardLine?.amount).toBe(1.75);
      expect(cardLine?.formula).toContain("2.9%");
      expect(cardLine?.formula).toContain("$0.30");
    });
  });
});
