/**
 * Campaign method timing rules (Nick V2 Layer 2 + Timeline Check bands).
 *
 * Purpose: Server source of truth for business-method lead times.
 * - Online donations / ambassador: end date only; no hard business-lead block.
 * - Dine & Donate / giveback: start date anchor.
 * - Guest Bartending: event date anchor.
 * - Bands (business methods):
 *   - 30+ days → ok (healthy)
 *   - 21–29 days → limited_promotion_window (continue with warning)
 *   - 8–20 days → tight_timeline (confirm business / ForkUp review / switch)
 *   - 0–7 days → too_soon (block new business-based campaigns)
 * - Business acceptance inside 21 days of start/event → limited_promotion_window
 *   (acceptance helper; unchanged).
 *
 * Inputs: selected methods + dates (+ optional confirmation / review flags).
 * Outputs: timing status + messages + CTAs.
 */
import { toDateOnlyString } from "./date-only";
import type { MethodType } from "../types/campaign";
import { METHOD_REQUIRES_BUSINESS } from "./methods";

export const BUSINESS_METHOD_MIN_LEAD_DAYS = 30;
export const LIMITED_PROMOTION_LEAD_DAYS = 21;
export const TIGHT_TIMELINE_MIN_DAYS = 8;
export const FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS = 21;
export const AMBASSADOR_RECOMMENDED_DAYS = 14;

export type TimingStatus =
  | "ok"
  | "needs_forkup_review"
  | "limited_promotion_window"
  | "tight_timeline"
  | "too_soon";

export type TimingCta =
  | "change_date"
  | "continue_without_business_method"
  | "confirm_business"
  | "submit_for_forkup_review";

export type MethodTimingEvaluation = {
  status: TimingStatus;
  message: string | null;
  ctas: TimingCta[];
  daysUntilAnchor: number | null;
  anchorDate: string | null;
  anchorKind: "start" | "event" | "end" | null;
};

/** Organizer “I already have a business confirmed” form (Timeline Check). */
export type BusinessConfirmationInput = {
  confirmedBusinessName?: string | null;
  confirmedContactName?: string | null;
  confirmedContactEmail?: string | null;
  confirmedMethod?: string | null;
  confirmedStatus?: string | null;
  confirmedNotes?: string | null;
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
 * Map whole days until start/event into a Timeline Check band status.
 * Inputs: days (>=0 expected). Outputs: TimingStatus band (never needs_forkup_review).
 */
export function timingBandFromDays(days: number): TimingStatus {
  if (days >= BUSINESS_METHOD_MIN_LEAD_DAYS) return "ok";
  if (days >= LIMITED_PROMOTION_LEAD_DAYS) return "limited_promotion_window";
  if (days >= TIGHT_TIMELINE_MIN_DAYS) return "tight_timeline";
  return "too_soon";
}

/**
 * True when the confirmation form has all required fields.
 * Required: business name, contact name, email, method (email|phone|in_person), status.
 */
export function isBusinessConfirmationComplete(
  input: BusinessConfirmationInput | null | undefined,
): boolean {
  if (!input) return false;
  const name = String(input.confirmedBusinessName ?? "").trim();
  const contact = String(input.confirmedContactName ?? "").trim();
  const email = String(input.confirmedContactEmail ?? "").trim();
  const method = String(input.confirmedMethod ?? "").trim().toLowerCase();
  const status = String(input.confirmedStatus ?? "").trim();
  if (!name || !contact || !email || !method || !status) return false;
  if (!["email", "phone", "in_person"].includes(method)) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  return true;
}

/**
 * Validates confirmation payload when the organizer claims a business is confirmed.
 * Returns an error string, or null when complete/valid.
 */
export function validateBusinessConfirmation(
  input: BusinessConfirmationInput | null | undefined,
): string | null {
  if (isBusinessConfirmationComplete(input)) return null;
  return "Business confirmation requires business name, contact name, contact email, confirmation method (email / phone / in person), and confirmation status";
}

/** True when any confirmation field was sent (partial or full). */
export function hasAnyBusinessConfirmationField(
  input: BusinessConfirmationInput | null | undefined,
): boolean {
  if (!input) return false;
  return Boolean(
    String(input.confirmedBusinessName ?? "").trim() ||
      String(input.confirmedContactName ?? "").trim() ||
      String(input.confirmedContactEmail ?? "").trim() ||
      String(input.confirmedMethod ?? "").trim() ||
      String(input.confirmedStatus ?? "").trim() ||
      String(input.confirmedNotes ?? "").trim(),
  );
}

/**
 * Whether business-invite emails may go out for this timing status.
 * limited_promotion_window: yes (warning only).
 * tight_timeline: only when business is already confirmed.
 * needs_forkup_review / too_soon: no.
 */
export function allowsBusinessInviteEmails(
  status: string | null | undefined,
  opts?: {
    businessConfirmed?: boolean;
    forkupReviewStatus?: string | null;
  },
): boolean {
  if (opts?.forkupReviewStatus === "approved") return true;
  const s = status ?? "ok";
  if (s === "ok" || s === "limited_promotion_window") return true;
  if (s === "tight_timeline" && opts?.businessConfirmed) return true;
  return false;
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

function bandMessage(
  status: TimingStatus,
  days: number,
  kind: "start" | "event",
): string {
  const when =
    kind === "event" ? `event is ${days} day${days === 1 ? "" : "s"} away` : `campaign starts in ${days} day${days === 1 ? "" : "s"}`;
  if (status === "limited_promotion_window") {
    return `Limited promotion window: your ${when}. You can continue, but there is less time for businesses to accept and for full promotion.`;
  }
  if (status === "tight_timeline") {
    return `Tight timeline: your ${when}. Businesses usually need more time to prepare and promote. Confirm an existing business agreement, submit for ForkUp review, change the date, or continue with Online Donation / Ambassador Sharing only.`;
  }
  if (status === "too_soon") {
    return `Too soon: your ${when}. New business-based campaigns cannot start within 7 days. Change the date or switch to Online Donation / Ambassador Sharing.`;
  }
  return "";
}

const TIGHT_CTAS: TimingCta[] = [
  "change_date",
  "continue_without_business_method",
  "confirm_business",
  "submit_for_forkup_review",
];

const TOO_SOON_CTAS: TimingCta[] = [
  "change_date",
  "continue_without_business_method",
];

/**
 * Evaluates business-method lead time into Timeline Check bands.
 * ForkUp review is a CTA outcome (stored separately), not an automatic band.
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

  let worstDays: number | null = null;
  let anchorDate: string | null = null;
  let anchorKind: "start" | "event" | null = null;

  const considerAnchor = (
    dateStr: string | null | undefined,
    kind: "start" | "event",
  ) => {
    const normalized = toDateOnlyString(dateStr);
    const days = daysUntil(normalized);
    if (days == null) return;
    if (worstDays == null || days < worstDays) {
      worstDays = days;
      anchorDate = normalized;
      anchorKind = kind;
    }
  };

  if (hasGivebackMethods(methods)) {
    considerAnchor(input.startDate, "start");
  }
  if (hasGuestBartending(methods)) {
    considerAnchor(input.eventDate, "event");
  }
  if (!hasGivebackMethods(methods) && !hasGuestBartending(methods)) {
    considerAnchor(input.startDate, "start");
  }

  if (worstDays == null || !anchorKind) {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: null,
      anchorDate,
      anchorKind,
    };
  }

  // Approved ForkUp review clears short-timeline gates.
  if (reviewApproved) {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: worstDays,
      anchorDate,
      anchorKind,
    };
  }

  const band = timingBandFromDays(worstDays);
  if (band === "ok") {
    return {
      status: "ok",
      message: null,
      ctas: [],
      daysUntilAnchor: worstDays,
      anchorDate,
      anchorKind,
    };
  }

  const message = bandMessage(band, worstDays, anchorKind);
  if (band === "limited_promotion_window") {
    return {
      status: "limited_promotion_window",
      message,
      ctas: [],
      daysUntilAnchor: worstDays,
      anchorDate,
      anchorKind,
    };
  }
  if (band === "tight_timeline") {
    return {
      status: "tight_timeline",
      message,
      ctas: [...TIGHT_CTAS],
      daysUntilAnchor: worstDays,
      anchorDate,
      anchorKind,
    };
  }
  return {
    status: "too_soon",
    message,
    ctas: [...TOO_SOON_CTAS],
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
