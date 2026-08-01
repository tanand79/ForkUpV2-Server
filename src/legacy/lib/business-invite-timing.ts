/**
 * Business invitation respond-by calculator (Nick V2 Layer 3).
 *
 * Purpose: Every business invite needs a clear Respond By date.
 * Default is 7 days after send, capped so acceptance can still land
 * 21+ days before start/event when the timeline allows.
 *
 * Inputs: sent date + campaign/event start anchor.
 * Outputs: YYYY-MM-DD respond_by_date.
 */
import { addCalendarDays, subtractCalendarDays, toDateOnlyString } from "./date-only";
import { FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS } from "./campaign-timing";

export const DEFAULT_INVITE_RESPONSE_DAYS = 7;

/**
 * Computes respond-by for a business invitation.
 * respondBy = min(sent + 7, startOrEvent - 21), but never before sent date.
 * If the 21-day floor is already before sent, fall back to sent + 7 (tight timeline).
 */
export function computeRespondByDate(input: {
  sentDate?: string | Date | null;
  startOrEventDate?: string | Date | null;
}): string {
  const sent =
    toDateOnlyString(input.sentDate) ?? toDateOnlyString(new Date()) ?? "";
  if (!sent) {
    return toDateOnlyString(new Date()) ?? "";
  }

  const defaultRespondBy = addCalendarDays(sent, DEFAULT_INVITE_RESPONSE_DAYS);
  const anchor = toDateOnlyString(input.startOrEventDate);
  if (!anchor) return defaultRespondBy;

  const seFloor = subtractCalendarDays(anchor, FULL_SUCCESS_ENGINE_ACCEPT_LEAD_DAYS);
  // Prefer the earlier of default respond-by and SE acceptance floor.
  let respondBy =
    seFloor && seFloor < defaultRespondBy ? seFloor : defaultRespondBy;

  // Never set respond-by before the invite is sent.
  if (respondBy < sent) {
    respondBy = defaultRespondBy;
  }

  return respondBy;
}

/** True when respond_by_date is before today (local calendar). */
export function isRespondByPassed(respondByDate?: string | Date | null): boolean {
  const respondBy = toDateOnlyString(respondByDate);
  const today = toDateOnlyString(new Date());
  if (!respondBy || !today) return false;
  return respondBy < today;
}

export type SetupReadiness = {
  setupStatus: "pending" | "needs_info" | "ready" | "complete";
  settlementReadyStatus: "pending" | "needs_info" | "ready";
  marketingReadyStatus: "pending" | "ready" | "blocked";
  /** invite_status after accept — needs_info or ready (acceptance_status stays accepted). */
  inviteStatusAfterAccept: "needs_info" | "ready";
};

/**
 * Derives post-accept setup readiness from ACH + contact fields.
 * Inputs: acceptance form fields. Outputs: setup / settlement / marketing statuses.
 */
export function deriveSetupReadiness(input: {
  achAuthorized?: boolean;
  billingContactEmail?: string | null;
  settlementContactEmail?: string | null;
  authorizedRepresentative?: string | null;
}): SetupReadiness {
  const hasRep = Boolean(input.authorizedRepresentative?.trim());
  const hasBilling = Boolean(input.billingContactEmail?.includes("@"));
  const hasSettlement = Boolean(input.settlementContactEmail?.includes("@"));
  const hasAch = Boolean(input.achAuthorized);
  const complete = hasRep && hasBilling && hasSettlement && hasAch;

  if (complete) {
    return {
      setupStatus: "ready",
      settlementReadyStatus: "ready",
      marketingReadyStatus: "ready",
      inviteStatusAfterAccept: "ready",
    };
  }

  return {
    setupStatus: "needs_info",
    settlementReadyStatus: hasAch && hasSettlement ? "ready" : "needs_info",
    marketingReadyStatus: "pending",
    inviteStatusAfterAccept: "needs_info",
  };
}
