import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

/**
 * Additive campaign columns for old SettlementEngine parity (fees + manual amounts).
 * NULL fee columns mean “use platform defaults” (15% / 2.9% / $0.30).
 * Tips/auction default 0 and stay excluded from giveback % until Pass 2 reads them.
 */
const SETTLEMENT_PARITY_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS platform_fee_percent DECIMAL(6,2);
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS card_fee_percent DECIMAL(6,3);
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS card_fee_fixed DECIMAL(10,2);
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS bartender_tips DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS silent_auction DECIMAL(12,2) NOT NULL DEFAULT 0;
`;

export async function migrateSettlementParity(options: DbTaskOptions = {}) {
  await pool.query(SETTLEMENT_PARITY_DDL);
  console.log(
    "ForkUp settlement parity columns applied (campaign platform/card fees, bartender_tips, silent_auction).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateSettlementParity().catch((err) => {
    console.error("Settlement parity migration failed:", err);
    process.exit(1);
  });
}
