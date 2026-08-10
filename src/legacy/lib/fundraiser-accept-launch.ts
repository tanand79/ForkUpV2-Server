/**
 * Promote a fundraiser-proposed draft campaign when the nonprofit accepts.
 *
 * Purpose: On invite accept, move campaign_status from draft to the same
 * post-launch status builder/go-live would choose (invitation_phase |
 * ready_to_launch | live), then promote ready→live when start date is due.
 * Never skips ForkUp review when timing requires it or review is already pending.
 *
 * Inputs: DB connection, campaign id, optional start date from campaigns row.
 * Outputs: resulting campaign_status string (unchanged if not draft).
 *
 * Changelog:
 * - Additive ForkUp-review gate: short-timeline / pending review → in_review
 *   instead of ready_to_launch / live.
 */
import type { PoolClient, QueryResultRow } from "pg";
import { maybePromoteCampaignToLive } from "./invitations";
import { toDateOnlyString } from "./date-only";
import {
  evaluateBusinessMethodTiming,
} from "./campaign-timing";
import type { MethodType } from "../types/campaign";

type LaunchStatus = "invitation_phase" | "ready_to_launch" | "live";

function isStartDateReached(startDate: string): boolean {
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start.getTime() <= today.getTime();
}

/**
 * Same rules as builder resolveLaunchStatus / campaign-go-live-from-review.
 * Default fundraising layer (donations/ambassador) is not blocked by business invites.
 */
async function resolveLaunchStatus(
  connection: PoolClient,
  campaignId: number,
  startDate?: string | null,
): Promise<LaunchStatus> {
  const { rows: methods } = await connection.query<QueryResultRow>(
    `SELECT requires_business_acceptance
     FROM campaign_methods WHERE campaign_id = $1`,
    [campaignId],
  );
  const hasDefaultFundraisingLayer = methods.some(
    (m) => !Boolean(m.requires_business_acceptance),
  );

  if (!hasDefaultFundraisingLayer) {
    const { rows: pending } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaign_business_locations
       WHERE campaign_id = $1
         AND acceptance_status NOT IN ('accepted', 'live', 'completed')
       LIMIT 1`,
      [campaignId],
    );
    if (pending.length > 0) return "invitation_phase";

    const { rows: partners } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaign_business_locations WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    if (partners.length === 0) return "invitation_phase";
  }

  const start = startDate ? toDateOnlyString(startDate) : null;
  if (start && isStartDateReached(start)) return "live";
  return "ready_to_launch";
}

/**
 * method helper: promote draft campaign after fundraiser invite accept.
 * Only updates campaigns still in draft. Promotes draft methods toward launch
 * unless ForkUp review is required — then keeps the campaign in_review.
 */
export async function promoteFundraiserDraftOnAccept(
  connection: PoolClient,
  campaignId: number,
  startDate?: string | Date | null,
): Promise<string> {
  const { rows } = await connection.query<QueryResultRow>(
    `SELECT campaign_status, campaign_start_date, event_date,
            forkup_review_status, business_timing_status
     FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (rows.length === 0) {
    return "draft";
  }

  const current = String(rows[0].campaign_status);
  if (current === "in_review") {
    return "in_review";
  }
  if (current !== "draft") {
    return current;
  }

  const start =
    toDateOnlyString(startDate) ??
    toDateOnlyString(rows[0].campaign_start_date);
  const eventDate = toDateOnlyString(rows[0].event_date);
  const forkupStatus = String(rows[0].forkup_review_status ?? "none");
  const businessTiming = String(rows[0].business_timing_status ?? "ok");

  const { rows: methodRows } = await connection.query<QueryResultRow>(
    `SELECT method_type FROM campaign_methods WHERE campaign_id = $1`,
    [campaignId],
  );
  const methodTypes = methodRows.map((r) => String(r.method_type) as MethodType);

  const timingEval = evaluateBusinessMethodTiming({
    methods: methodTypes,
    startDate: start,
    eventDate,
  });

  const needsForkupReview =
    timingEval.status === "needs_forkup_review" ||
    businessTiming === "needs_forkup_review" ||
    forkupStatus === "pending" ||
    forkupStatus === "changes_requested";

  // Stay in ForkUp review — never skip to live / ready when review is required.
  if (needsForkupReview) {
    await connection.query(
      `UPDATE campaigns SET
         campaign_status = 'in_review',
         business_timing_status = CASE
           WHEN $2::text = 'needs_forkup_review' THEN 'needs_forkup_review'
           ELSE business_timing_status
         END,
         forkup_review_status = CASE
           WHEN forkup_review_status IN ('approved', 'denied') THEN forkup_review_status
           ELSE 'pending'
         END,
         forkup_review_requested_at = COALESCE(forkup_review_requested_at, NOW()),
         updated_at = NOW()
       WHERE id = $1 AND campaign_status = 'draft'`,
      [
        campaignId,
        timingEval.status === "needs_forkup_review" ||
        businessTiming === "needs_forkup_review"
          ? "needs_forkup_review"
          : businessTiming,
      ],
    );
    if (
      timingEval.status === "needs_forkup_review" ||
      businessTiming === "needs_forkup_review"
    ) {
      await connection.query(
        `UPDATE campaign_methods
         SET timing_status = 'needs_forkup_review', updated_at = NOW()
         WHERE campaign_id = $1`,
        [campaignId],
      );
    }
    return "in_review";
  }

  const nextStatus = await resolveLaunchStatus(connection, campaignId, start);

  await connection.query(
    `UPDATE campaigns SET campaign_status = $1, updated_at = NOW()
     WHERE id = $2 AND campaign_status = 'draft'`,
    [nextStatus, campaignId],
  );

  // Align draft methods with launch path (builder uses invited; live uses live).
  if (nextStatus === "live") {
    await connection.query(
      `UPDATE campaign_methods
       SET method_status = 'live', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`,
      [campaignId],
    );
  } else if (nextStatus === "ready_to_launch") {
    await connection.query(
      `UPDATE campaign_methods
       SET method_status = 'scheduled', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`,
      [campaignId],
    );
  } else {
    await connection.query(
      `UPDATE campaign_methods
       SET method_status = 'invited', updated_at = NOW()
       WHERE campaign_id = $1 AND method_status = 'draft'`,
      [campaignId],
    );
  }

  await maybePromoteCampaignToLive(connection, campaignId);

  const { rows: statusRows } = await connection.query<QueryResultRow>(
    `SELECT campaign_status FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  return String(statusRows[0]?.campaign_status ?? nextStatus);
}
