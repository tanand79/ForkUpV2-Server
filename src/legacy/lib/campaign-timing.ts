/**
 * Campaign method timing rules (Nick V2 Layer 2).
 *
 * Purpose: Server source of truth for business-method lead times.
 * - Online donations / ambassador: end date only; no 30-day hard block.
 * - Dine & Donate / giveback methods: start date + ≥30 days lead, else needs_forkup_review.
 * - Guest Bartending: event date + ≥30 days lead, else needs_forkup_review.
 * - Business acceptance inside 21 days of start/event → limited_promotion_window.
 *
 * Inputs: selected methods + dates. Outputs: timing status + messages (never "rejected").
 */
import { toDateOnlyString } from "./date-only";
import type { MethodType } from "../types/campaign";
import { METHOD_REQUIRES_BUSINESS } from "./methods";

export const BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
export const FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = 21;
export const AMBASSADOR_RECOMMENDED_DAYS = 14;

export type TimingStatus =
  | "ok"
  | "needs_forkup_review"
  | "limited_promotion_window";

export type TimingCta =
  | "change_date"
  | "continue_without_business_method"
  | "submit_for_forkup_review";

export type MethodTimingEvaluation = {
  status: TimingStatus;
  message: string | null;
  ctas: TimingCta[];
  daysUntilAnchor: number | null;
  anchorDate: string | null;
  anchorKind: "start" | "event" | "end" | null;
};

function todayDateOnly(): string {
  return toDateOnlyString(new Date()) ?? "";
}

/** Whole calendar days from today (local) until target YYYY-MM-DD. */
export function daysUntil(dateStr: string | null | undefined): number | null {
  const target = toDateOnlyString(dateStr);
  if (!target) return null;
  const today = todayDateOnly();
  if (!today) return null;
  const [ty, tm, td] = today.split("-").map(Number);
  const [ay, am, ad] = target.split("-").map(Number);
  const t0 = new Date(ty, tm - 1, td).getTime();
  const a0 = new Date(ay, am - 1, ad).getTime();
  return Math.round((a0 - t0) / (24 * 60 * 60 * 1000));
}

export function hasBusinessMethods(methods: MethodType[]): boolean {
  return methods.some((m) => METHOD_REQUIRES_BUSINESS[m]);
}

export function hasGivebackMethods(methods: MethodType[]): boolean {
  return methods.some(
    (m) =>
      m === "dine_and_donate" ||
      m === "shop_and_donate" ||
      m === "service_giveback",
  );
}

export function hasGuestBartending(methods: MethodType[]): boolean {
  return methods.includes("guest_bartending_event");
}

export function hasDefaultFundraisingLayer(methods: MethodType[]): boolean {
  return methods.some((m) => !METHOD_REQUIRES_BUSINESS[m]);
}

/**
 * Validates date requirements by selected methods.
 * Returns an error string when required dates are missing; null when OK.
 */
export function validateMethodDateRequirements(input: {
  methods: MethodType[];
  startDate?: string | null;
  endDate?: string | null;
  eventDate?: string | null;
}): string | null {
  const { methods } = input;
  const endDate = toDateOnlyString(input.endDate);
  const startDate = toDateOnlyString(input.startDate);
  const eventDate = toDateOnlyString(input.eventDate);

  if (!endDate && !hasGuestBartending(methods)) {
    // Guest-bartending-only may use event_date as the anchor; otherwise end is required.
    if (!hasBusinessMethods(methods) || hasDefaultFundraisingLayer(methods) || hasGivebackMethods(methods)) {
      return "Campaign end date is required";
    }
  }

  if (hasGivebackMethods(methods)) {
    if (!startDate) return "Campaign start date is required for Dine & Donate / Local Giveback";
    if (!endDate) return "Campaign end date is required for Dine & Donate / Local Giveback";
  }

  if (hasGuestBartending(methods)) {
    if (!eventDate) return "Event date is required for Guest Bartending";
  }

  // Online/ambassador only: end date required; start optional (already covered).
  if (!hasBusinessMethods(methods) && !endDate) {
    return "Campaign end date is required";
  }

  // Hard block: organizers cannot create/save campaigns dated before today.
  const today = todayDateOnly();
  if (startDate && today && startDate < today) {
    return "Campaign start date cannot be in the past";
  }
  if (endDate && today && endDate < today) {
    return "Campaign end date cannot be in the past";
  }
  if (eventDate && today && eventDate < today) {
    return "Event date cannot be in the past";
  }

  return null;
}

/**
 * Evaluates business-method lead time. Short timelines are Needs ForkUp Review — not rejected.
 */
export function evaluateBusinessMethodTiming(input: {
  methods: MethodType[];
  startDate?: string | null;
  eventDate?: string | null;
  forkupReviewStatus?: string | null;
}): MethodTimingEvaluation {
  const methods = input.methods;
  const reviewApproved = input.forkupReviewStatus === "approved";

  if (!hasBusinessMethods(methods)) {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: null,
      anchorDate: null,
      anchorKind: null,
    };
  }

  /**
   * Evaluate each selected business method on its own date anchor.
   * When giveback + guest bartending are both selected, both can need ForkUp
   * review — do not prefer one method and skip the other.
   */
  const GIVEBACK_SHORT_MSG =
    "This campaign starts in less than 30 days. Business giveback campaigns need time for businesses to accept, prepare their team, and promote the campaign. ForkUp review is required before inviting businesses for this timeline.";
  const GUEST_SHORT_MSG =
    "Guest Bartending events need enough time to confirm the venue, prepare the guest bartenders, promote the event, and alert the business team. ForkUp review is required for events less than 30 days away.";
  const OTHER_BUSINESS_SHORT_MSG =
    "This business-based method starts in less than 30 days. ForkUp review is required before proceeding normally.";

  const shortMessages: string[] = [];
  let worstDays: number | null = null;
  let anchorDate: string | null = null;
  let anchorKind: "start" | "event" | null = null;

  const considerAnchor = (
    dateStr: string | null | undefined,
    kind: "start" | "event",
    shortMessage: string,
  ) => {
    const normalized = toDateOnlyString(dateStr);
    const days = daysUntil(normalized);
    if (days == null) return;
    if (worstDays == null || days < worstDays) {
      worstDays = days;
      anchorDate = normalized;
      anchorKind = kind;
    }
    if (days < BUSINESS_METHOD_MIN_LEAD_DAYS && !reviewApproved) {
      shortMessages.push(shortMessage);
    }
  };

  if (hasGivebackMethods(methods)) {
    considerAnchor(input.startDate, "start", GIVEBACK_SHORT_MSG);
  }
  if (hasGuestBartending(methods)) {
    considerAnchor(input.eventDate, "event", GUEST_SHORT_MSG);
  }
  if (!hasGivebackMethods(methods) && !hasGuestBartending(methods)) {
    // Other business methods (shouldn't happen with current set) — use start.
    considerAnchor(input.startDate, "start", OTHER_BUSINESS_SHORT_MSG);
  }

  if (worstDays == null) {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: null,
      anchorDate,
      anchorKind,
    };
  }

  if (shortMessages.length === 0) {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: worstDays,
      anchorDate,
      anchorKind,
    };
  }

  return {
    status: "needs_forkup_review",
    message: shortMessages.join(" "),
    ctas: [
      "change_date",
      "continue_without_business_method",
      "submit_for_forkup_review",
    ],
    daysUntilAnchor: worstDays,
    anchorDate,
    anchorKind,
  };
}

/**
 * After a business accepts: full SE needs ≥21 days before start/event.
 * Inside 21 days → limited_promotion_window (campaign can still happen).
 */
export function evaluateAcceptancePromotionWindow(input: {
  startOrEventDate?: string | null;
}): TimingStatus {
  const days = daysUntil(input.startOrEventDate);
  if (days == null) return "ok";
  if (days < FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS) {
    return "limited_promotion_window";
  }
  return "ok";
}

/** Soft coaching for ambassador window (no hard block). */
export function ambassadorTimingCoachMessage(endDate?: string | null): string | null {
  const days = daysUntil(endDate);
  if (days == null) return null;
  if (days < AMBASSADOR_RECOMMENDED_DAYS) {
    return "This campaign can launch, but a longer window usually gives ambassadors more time to share and raise support.";
  }
  return null;
}
