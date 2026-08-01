/**
 * Nick V2 Layer 6 — Campaign dashboard visibility projection.
 *
 * Purpose: Derive ready / pending / ForkUp review / business-action / next SE
 * signals from existing campaign, method, invite, and SE rows (no new tables).
 *
 * Inputs: campaign timing fields, method types, partner rows, next SE action.
 * Outputs: visibility object for dashboard APIs/UI.
 */

import type { MethodType } from "../types/campaign";
import {
  hasDefaultFundraisingLayer,
  hasGivebackMethods,
  hasGuestBartending,
} from "./campaign-timing";

export type VisibilityTrackStatus =
  | "not_selected"
  | "ready"
  | "waiting_on_business_acceptance"
  | "event_details_needed"
  | "payment_setup_needed"
  | "pending_setup"
  | "needs_forkup_review"
  | "limited_promotion_window";

export type VisibilityTrack = {
  id: string;
  label: string;
  status: VisibilityTrackStatus;
  display: string;
};

export type NextSuccessEngineAction = {
  id: number;
  title: string;
  scheduledDate: string | null;
  actionType: string;
} | null;

export type CampaignVisibility = {
  tracks: VisibilityTrack[];
  ready: string[];
  pending: string[];
  needsForkupReview: string[];
  needsBusinessAction: string[];
  nextSuccessEngineAction: NextSuccessEngineAction;
};

export type VisibilityPartner = {
  businessName: string;
  acceptanceStatus: string;
  inviteStatus?: string | null;
  respondByDate?: string | null;
  setupStatus?: string | null;
  settlementReadyStatus?: string | null;
};

const TRACK_DISPLAY: Record<VisibilityTrackStatus, string> = {
  not_selected: "Not selected",
  ready: "Ready",
  waiting_on_business_acceptance: "Waiting on business acceptance",
  event_details_needed: "Event details needed",
  payment_setup_needed: "Payment setup needed",
  pending_setup: "Setup needed",
  needs_forkup_review: "Needs ForkUp Review",
  limited_promotion_window: "Limited Promotion Window",
};

function isAccepted(status: string): boolean {
  return ["accepted", "ready", "live", "completed"].includes(status);
}

function isAwaitingBusiness(status: string): boolean {
  return ["draft", "invited", "opened", "pending", "changes_requested", "needs_info"].includes(
    status,
  );
}

/**
 * Build Nick L6 visibility summary for a campaign.
 */
export function buildCampaignVisibility(input: {
  methods: MethodType[];
  campaignStatus: string;
  businessTimingStatus?: string | null;
  forkupReviewStatus?: string | null;
  eventDate?: string | null;
  endDate?: string | null;
  coverPresent?: boolean;
  storyPresent?: boolean;
  partners: VisibilityPartner[];
  nextSuccessEngineAction?: NextSuccessEngineAction;
}): CampaignVisibility {
  const methods = input.methods;
  const accepted = input.partners.filter((p) => isAccepted(String(p.acceptanceStatus)));
  const awaiting = input.partners.filter((p) =>
    isAwaitingBusiness(String(p.acceptanceStatus)),
  );
  const missingSetup = accepted.filter(
    (p) =>
      String(p.setupStatus) === "needs_info" ||
      String(p.settlementReadyStatus) === "needs_info" ||
      String(p.inviteStatus) === "needs_info",
  );

  const timingGate: VisibilityTrackStatus | null =
    input.businessTimingStatus === "limited_promotion_window"
      ? "limited_promotion_window"
      : input.businessTimingStatus === "needs_forkup_review" ||
          input.forkupReviewStatus === "pending"
        ? "needs_forkup_review"
        : null;

  const basicsReady = Boolean(input.storyPresent && input.endDate);

  let online: VisibilityTrackStatus = "not_selected";
  if (methods.includes("virtual_donations")) {
    online = basicsReady ? "ready" : "pending_setup";
  }

  let ambassador: VisibilityTrackStatus = "not_selected";
  if (methods.includes("ambassador_fundraising") || hasGuestBartending(methods)) {
    ambassador = basicsReady ? "ready" : "pending_setup";
  }

  let giveback: VisibilityTrackStatus = "not_selected";
  if (hasGivebackMethods(methods)) {
    if (timingGate) giveback = timingGate;
    else if (accepted.length > 0) giveback = "ready";
    else giveback = "waiting_on_business_acceptance";
  }

  let guest: VisibilityTrackStatus = "not_selected";
  if (hasGuestBartending(methods)) {
    if (timingGate) guest = timingGate;
    else if (!input.eventDate) guest = "event_details_needed";
    else if (accepted.length > 0) guest = "ready";
    else guest = "waiting_on_business_acceptance";
  }

  let settlement: VisibilityTrackStatus = "not_selected";
  if (hasGivebackMethods(methods) || hasGuestBartending(methods)) {
    if (accepted.length === 0) settlement = "waiting_on_business_acceptance";
    else if (missingSetup.length > 0) settlement = "payment_setup_needed";
    else settlement = "ready";
  } else if (hasDefaultFundraisingLayer(methods)) {
    settlement = "ready";
  }

  const trackDefs: Array<{ id: string; label: string; status: VisibilityTrackStatus }> = [
    { id: "online", label: "Online Donations", status: online },
    { id: "ambassador", label: "Ambassador Sharing", status: ambassador },
    { id: "giveback", label: "Business Giveback", status: giveback },
    { id: "guest", label: "Guest Bartending", status: guest },
    { id: "settlement", label: "Settlement", status: settlement },
  ];

  const tracks: VisibilityTrack[] = trackDefs
    .filter((t) => t.status !== "not_selected")
    .map((t) => ({
      ...t,
      display: TRACK_DISPLAY[t.status],
    }));

  const ready: string[] = [];
  const pending: string[] = [];
  const needsForkupReview: string[] = [];
  const needsBusinessAction: string[] = [];

  for (const t of tracks) {
    if (t.status === "ready") ready.push(`${t.label}: Ready`);
    else if (t.status === "needs_forkup_review") {
      needsForkupReview.push(`${t.label}: Needs ForkUp Review`);
    } else if (t.status === "limited_promotion_window") {
      pending.push(`${t.label}: Limited Promotion Window`);
    } else {
      pending.push(`${t.label}: ${t.display}`);
    }
  }

  if (
    input.businessTimingStatus === "needs_forkup_review" ||
    input.forkupReviewStatus === "pending"
  ) {
    if (!needsForkupReview.length) {
      needsForkupReview.push("Business methods need ForkUp review before invites can proceed.");
    }
  }

  for (const p of awaiting) {
    const by = p.respondByDate ? ` (respond by ${p.respondByDate})` : "";
    needsBusinessAction.push(`${p.businessName}: awaiting response${by}`);
  }
  for (const p of missingSetup) {
    needsBusinessAction.push(`${p.businessName}: finish setup / payment info`);
  }

  if (input.campaignStatus === "draft" && ready.length === 0 && pending.length === 0) {
    pending.push("Campaign setup still in progress");
  }

  return {
    tracks,
    ready,
    pending,
    needsForkupReview,
    needsBusinessAction,
    nextSuccessEngineAction: input.nextSuccessEngineAction ?? null,
  };
}
