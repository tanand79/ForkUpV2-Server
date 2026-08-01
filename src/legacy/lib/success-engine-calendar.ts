/**
 * Success Engine calendar builder (Nick V2 Layer 4).
 *
 * Purpose: Build a rule-based 60→0 day operating plan from campaign methods
 * and dates. AI may polish copy later; this module enforces readiness gates
 * (e.g. no business promo materials before acceptance).
 *
 * Inputs: methods, start/event/end dates, whether any business has accepted.
 * Outputs: list of draft success_engine_actions rows (not yet persisted).
 */
import { addCalendarDays, subtractCalendarDays, toDateOnlyString } from "./date-only";
import type { MethodType } from "../types/campaign";
import { METHOD_REQUIRES_BUSINESS } from "./methods";

export type CalendarDraftAction = {
  action_type: string;
  channel: "email" | "text" | "social";
  scheduled_date: string;
  title: string;
  content: string;
  stakeholder_role: "nonprofit" | "business" | "ambassador" | "supporter" | "admin";
  generated_by: "system" | "ai";
};

function daysBefore(anchor: string, days: number): string {
  return subtractCalendarDays(anchor, days);
}

function clampNotAfter(date: string, end: string): string {
  return date > end ? end : date;
}

/**
 * Builds calendar draft actions for a campaign.
 * Business-facing promo actions are omitted when noBusinessAccepted is true.
 */
export function buildSuccessEngineCalendar(input: {
  campaignName: string;
  methods: MethodType[];
  startDate?: string | null;
  eventDate?: string | null;
  endDate?: string | null;
  nonprofitName?: string;
  hasAcceptedBusiness?: boolean;
}): CalendarDraftAction[] {
  const start =
    toDateOnlyString(input.startDate) ||
    toDateOnlyString(input.eventDate) ||
    toDateOnlyString(input.endDate);
  const end =
    toDateOnlyString(input.endDate) ||
    toDateOnlyString(input.eventDate) ||
    start;
  if (!start || !end) return [];

  const name = input.campaignName || "your campaign";
  const org = input.nonprofitName || "the nonprofit";
  const hasBusiness = input.methods.some((m) => METHOD_REQUIRES_BUSINESS[m]);
  const hasAmbassador =
    input.methods.includes("ambassador_fundraising") ||
    input.methods.includes("guest_bartending_event");
  const hasOnline = input.methods.includes("virtual_donations");
  const canBusinessPromo = Boolean(input.hasAcceptedBusiness);

  const actions: CalendarDraftAction[] = [];

  const push = (
    action_type: string,
    daysOut: number,
    title: string,
    content: string,
    stakeholder_role: CalendarDraftAction["stakeholder_role"],
    channel: CalendarDraftAction["channel"] = "email",
  ) => {
    const scheduled = clampNotAfter(daysBefore(start, daysOut), end);
    actions.push({
      action_type,
      channel,
      scheduled_date: scheduled,
      title,
      content,
      stakeholder_role,
      generated_by: "system",
    });
  };

  // 60–45: prep
  push(
    "nonprofit_announcement",
    50,
    "Draft nonprofit announcement",
    `Prepare an announcement for ${org} supporters about "${name}".`,
    "nonprofit",
  );

  if (hasBusiness) {
    push(
      "business_invite_reminder",
      40,
      "Send / follow up business invitations",
      `Invite or remind local businesses for "${name}". Nothing is public until they accept.`,
      "nonprofit",
    );
  }

  if (hasAmbassador) {
    push(
      "ambassador_recruitment",
      35,
      "Invite ambassadors",
      `Recruit ambassadors to share "${name}" with their networks.`,
      "ambassador",
    );
  }

  // 30–21: acceptance window materials (business only if accepted)
  if (hasBusiness && canBusinessPromo) {
    push(
      "staff_talking_points",
      25,
      "Business staff talking points",
      `Share talking points and QR language with participating businesses for "${name}".`,
      "business",
    );
    push(
      "business_promotion",
      22,
      "Business launch kit",
      `Promotional materials are ready for accepted business partners of "${name}".`,
      "business",
    );
  }

  // 21–14: first marketing push
  push(
    "launch_email",
    14,
    "Campaign announcement email",
    `Announce "${name}" to supporters. Share the campaign page and how to participate.`,
    "nonprofit",
  );
  push(
    "social_post",
    14,
    "Social post #1",
    `Share the first social post for "${name}".`,
    "nonprofit",
    "social",
  );

  // 14–7
  push(
    "one_week_reminder",
    7,
    "One week reminder",
    `One week until "${name}" — remind supporters and partners.`,
    "nonprofit",
  );
  push(
    "countdown_reminder",
    7,
    "Countdown reminder",
    `Countdown content for "${name}".`,
    "supporter",
  );

  if (hasBusiness && canBusinessPromo) {
    push(
      "day_of_reminder",
      1,
      "Business day-of reminder",
      `Remind business teams that "${name}" is live / starting.`,
      "business",
    );
  }

  // Launch / during
  if (hasOnline || hasAmbassador) {
    push(
      "mid_campaign_reminder",
      0,
      "Mid-campaign nudge",
      `Keep momentum for "${name}" — share progress and donation links.`,
      "nonprofit",
    );
  }

  push(
    "final_push_reminder",
    0,
    "Final push",
    `Final push for "${name}" before the campaign ends.`,
    "nonprofit",
  );

  if (hasOnline || hasBusiness) {
    push(
      "receipt_reminder",
      0,
      "Receipt upload reminder",
      `Remind supporters how to upload receipts for "${name}" if applicable.`,
      "supporter",
    );
  }

  // After end
  const thankYouDate = addCalendarDays(end, 1);
  actions.push({
    action_type: "thank_you",
    channel: "email",
    scheduled_date: thankYouDate,
    title: "Thank-you message",
    content: `Thank supporters and partners for "${name}".`,
    stakeholder_role: "nonprofit",
    generated_by: "system",
  });
  actions.push({
    action_type: "results_email",
    channel: "email",
    scheduled_date: addCalendarDays(end, 3),
    title: "Results recap",
    content: `Share results and impact for "${name}".`,
    stakeholder_role: "nonprofit",
    generated_by: "system",
  });
  actions.push({
    action_type: "settlement_recap",
    channel: "email",
    scheduled_date: addCalendarDays(end, 5),
    title: "Settlement recap",
    content: `Prepare settlement explanations for "${name}".`,
    stakeholder_role: "admin",
    generated_by: "system",
  });
  actions.push({
    action_type: "rebooking_prompt",
    channel: "email",
    scheduled_date: addCalendarDays(end, 14),
    title: "Rebooking prompt",
    content: `Invite ${org} to plan their next ForkUp campaign.`,
    stakeholder_role: "nonprofit",
    generated_by: "system",
  });

  // Dedupe by action_type + scheduled_date
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = `${a.action_type}|${a.scheduled_date}|${a.stakeholder_role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
