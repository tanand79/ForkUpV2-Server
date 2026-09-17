/**
 * Pass D3 — normalize Join Us giveback / cause preference fields.
 *
 * Purpose: Validate optional body fields from the 4-step giveback join funnel
 * before persisting on businesses.
 *
 * Inputs: unknown body fields.
 * Outputs: typed values or null (legacy / omitted).
 *
 * Changelog (D3): Added normalizeJoinGivebackMode, normalizeJoinCauseMode,
 * normalizePreferredCampaignSlug.
 */
export type JoinGivebackMode =
  | "restaurant_dine_percent"
  | "percent_of_purchase"
  | "dollar_per_visit"
  | "special_offer";

export type JoinCauseMode = "pick_now" | "forkup_match";

const GIVEBACK_MODES: JoinGivebackMode[] = [
  "restaurant_dine_percent",
  "percent_of_purchase",
  "dollar_per_visit",
  "special_offer",
];

const CAUSE_MODES: JoinCauseMode[] = ["pick_now", "forkup_match"];

/** Validate joinGivebackMode from claim/onboarding body. */
export function normalizeJoinGivebackMode(raw: unknown): JoinGivebackMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (GIVEBACK_MODES as string[]).includes(v) ? (v as JoinGivebackMode) : null;
}

/** Validate joinCauseMode from claim/onboarding body. */
export function normalizeJoinCauseMode(raw: unknown): JoinCauseMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (CAUSE_MODES as string[]).includes(v) ? (v as JoinCauseMode) : null;
}

/** Trim optional preferred campaign slug (max 255). */
export function normalizePreferredCampaignSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  return v.length <= 255 ? v : v.slice(0, 255);
}
