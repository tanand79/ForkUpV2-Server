/**
 * formatMoneyUSD — locale-aware USD display for settlement statements and emails.
 *
 * Purpose: show monetary values with thousands separators and two decimal places
 * (e.g. $1,400.00 instead of $1400.00).
 *
 * Inputs: numeric value (unknown coerced). Outputs: formatted string with $ prefix.
 */
export function formatMoneyUSD(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * formatMoneyNumber — comma-separated amount without currency symbol (CSV exports).
 */
export function formatMoneyNumber(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
