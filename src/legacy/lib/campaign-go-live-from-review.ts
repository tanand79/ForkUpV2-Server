/**
 * Promote a campaign after ForkUp / superadmin review approval.
 *
 * Purpose: Move campaign_status from in_review (or pending review) to the
 * correct post-launch status, seed Success Engine drafts, email the nonprofit
 * that the campaign is live / approved, and send deferred business invites.
 *
 * Inputs: campaign slug (must be in the ForkUp review queue / pending).
 * Outputs: { campaignId, slug, campaignStatus, emailSent }.
 */
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { maybePromoteCampaignToLive } from "./invitations";
import { sendInitialInvitationEmails } from "./business-lifecycle-emails";
import { sendEmail, resolveFrontendBaseUrl } from "./mailer";
import {
  fetchApprovedLibraryItems,
  pickLaunchSnippet,
  pickImpactSnippet,
} from "./organization-library";
import { addCalendarDays, toDateOnlyString } from "./date-only";

type LaunchStatus = "invitation_phase" | "ready_to_launch" | "live";

function isStartDateReached(startDate: string): boolean {
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start.getTime() <= today.getTime();
}

/** Midpoint calendar date between two YYYY-MM-DD strings (rounded down). */
function midpointDate(startDate: string, endDate: string): string {
  const start = toDateOnlyString(startDate);
  const end = toDateOnlyString(endDate);
  if (!start || !end) return startDate;
  const startMs = new Date(`${start}T00:00:00`).getTime();
  const endMs = new Date(`${end}T00:00:00`).getTime();
  const spanDays = Math.max(0, Math.round((endMs - startMs) / 86_400_000));
  return addCalendarDays(start, Math.floor(spanDays / 2));
}

/**
 * Resolves post-approval campaign status (mirrors builder resolveLaunchStatus).
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

async function insertSuccessEngineDraft(
  connection: PoolClient,
  campaignId: number,
  campaignName: string,
  startDate: string,
  endDate: string,
  nonprofitId: number,
): Promise<void> {
  const { rows: existing } = await connection.query<QueryResultRow>(
    "SELECT id FROM success_engine_actions WHERE campaign_id = $1 LIMIT 1",
    [campaignId],
  );
  if (existing.length > 0) return;

  const approvedItems = await fetchApprovedLibraryItems("nonprofit", nonprofitId);
  const snippet = pickLaunchSnippet(approvedItems);
  const impactSnippet = pickImpactSnippet(approvedItems);
  const launchContent = `Your campaign "${campaignName}" is live. Share it with supporters and encourage them to participate at your confirmed businesses.${
    snippet ? `\n\n${snippet}` : ""
  }`;
  const actions = [
    {
      action_type: "launch_email",
      title: "Campaign Launch Email",
      content: launchContent,
      scheduled_date: startDate,
    },
    {
      action_type: "one_week_reminder",
      title: "One Week Reminder",
      content: `One week left — remind supporters to visit participating businesses and upload receipts.${
        impactSnippet ? `\n\n${impactSnippet}` : ""
      }`,
      scheduled_date: endDate,
    },
    {
      action_type: "final_push_reminder",
      title: "Final Push Reminder",
      content: `Final days of the campaign — share progress and encourage last-minute participation.${
        impactSnippet ? `\n\n${impactSnippet}` : ""
      }`,
      scheduled_date: endDate,
    },
  ];
  for (const action of actions) {
    await connection.query(
      `INSERT INTO success_engine_actions (campaign_id, action_type, channel, scheduled_date, title, content, status)
       VALUES ($1, $2, 'email', $3, $4, $5, 'ready')`,
      [campaignId, action.action_type, action.scheduled_date, action.title, action.content],
    );
  }
  const start = toDateOnlyString(startDate);
  const end = toDateOnlyString(endDate);
  if (start && end) {
    const automated = [
      {
        action_type: "mid_campaign_reminder",
        title: "Mid-Campaign Reminder",
        content: `We're halfway there — remind supporters to visit participating businesses and upload their receipts.${
          impactSnippet ? `\n\n${impactSnippet}` : ""
        }`,
        scheduled_date: midpointDate(start, end),
      },
      {
        action_type: "receipt_reminder",
        title: "Receipt Upload Reminder",
        content:
          "The campaign has wrapped up — remind supporters to upload any remaining receipts so their visits count toward the goal.",
        scheduled_date: addCalendarDays(end, 2),
      },
    ];
    for (const action of automated) {
      await connection.query(
        `INSERT INTO success_engine_actions (campaign_id, action_type, channel, scheduled_date, title, content, status, auto_send)
         VALUES ($1, $2, 'email', $3, $4, $5, 'ready', TRUE)`,
        [campaignId, action.action_type, action.scheduled_date, action.title, action.content],
      );
    }
  }
}

export type PromoteFromReviewResult = {
  campaignId: number;
  slug: string;
  campaignStatus: string;
  forkupReviewStatus: string;
  businessTimingStatus: string;
  emailSent: boolean;
};

/**
 * After superadmin approves ForkUp review: clear timing gate, set launch status,
 * seed Success Engine, email nonprofit, send business invites.
 */
export async function promoteCampaignAfterForkupApproval(
  slug: string,
): Promise<PromoteFromReviewResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<QueryResultRow>(
      `UPDATE campaigns
       SET forkup_review_status = 'approved',
           business_timing_status = 'ok',
           updated_at = NOW()
       WHERE slug = $1
         AND (
           campaign_status = 'in_review'
           OR business_timing_status = 'needs_forkup_review'
           OR forkup_review_status = 'pending'
         )
         AND forkup_review_status NOT IN ('approved', 'denied', 'changes_requested')
       RETURNING id, slug, campaign_name, nonprofit_id,
                 campaign_start_date, campaign_end_date, event_date,
                 forkup_review_status, business_timing_status`,
      [slug],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const campaign = rows[0];
    const campaignId = Number(campaign.id);
    const nonprofitId = Number(campaign.nonprofit_id);
    const campaignName = String(campaign.campaign_name);
    const startDate =
      toDateOnlyString(campaign.campaign_start_date) ||
      toDateOnlyString(campaign.event_date) ||
      toDateOnlyString(campaign.campaign_end_date) ||
      "";
    const endDate =
      toDateOnlyString(campaign.campaign_end_date) ||
      toDateOnlyString(campaign.event_date) ||
      startDate;

    await client.query(
      `UPDATE campaign_methods
       SET timing_status = 'ok'
       WHERE campaign_id = $1
         AND timing_status = 'needs_forkup_review'`,
      [campaignId],
    );

    let nextStatus = await resolveLaunchStatus(
      client,
      campaignId,
      toDateOnlyString(campaign.campaign_start_date),
    );
    await client.query(
      `UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`,
      [nextStatus, campaignId],
    );
    await insertSuccessEngineDraft(
      client,
      campaignId,
      campaignName,
      startDate,
      endDate,
      nonprofitId,
    );
    await maybePromoteCampaignToLive(client, campaignId);

    const { rows: statusRows } = await client.query<QueryResultRow>(
      "SELECT campaign_status FROM campaigns WHERE id = $1",
      [campaignId],
    );
    nextStatus = String(
      statusRows[0]?.campaign_status ?? nextStatus,
    ) as LaunchStatus;

    const { rows: npRows } = await client.query<QueryResultRow>(
      `SELECT organization_name, contact_name, contact_email
       FROM nonprofits WHERE id = $1`,
      [nonprofitId],
    );

    await client.query("COMMIT");

    // Business invites only after approval (deferred from Launch submit).
    await sendInitialInvitationEmails(campaignId);

    let emailSent = false;
    const contactEmail = npRows[0]?.contact_email
      ? String(npRows[0].contact_email).trim()
      : "";
    if (contactEmail.includes("@")) {
      const base = resolveFrontendBaseUrl();
      const isLive = nextStatus === "live";
      const subject = isLive
        ? `Your ForkUp campaign "${campaignName}" is live`
        : `Your ForkUp campaign "${campaignName}" was approved`;
      const body = isLive
        ? `Good news — ForkUp approved your campaign "${campaignName}" and it is now live.\n\n` +
          `Share it with supporters: ${base}/campaign/${encodeURIComponent(slug)}\n\n` +
          `Thank you for fundraising with ForkUp.`
        : nextStatus === "invitation_phase"
          ? `ForkUp approved your campaign "${campaignName}". Business partners still need to accept before the campaign is fully ready.\n\n` +
            `Open your dashboard: ${base}/?step=nonprofit-dashboard\n\n` +
            `Thank you for fundraising with ForkUp.`
          : `ForkUp approved your campaign "${campaignName}". It will appear publicly on the start date` +
            (startDate ? ` (${startDate})` : "") +
            `.\n\n` +
            `Preview: ${base}/campaign/${encodeURIComponent(slug)}\n\n` +
            `Thank you for fundraising with ForkUp.`;

      const result = await sendEmail({
        to: contactEmail,
        name: npRows[0]?.contact_name ? String(npRows[0].contact_name) : null,
        subject,
        body,
        emailType: "campaign_review_approved_live",
        campaignId,
        platformSender: true,
        stakeholderRole: "nonprofit",
        relatedToken: `forkup-approve-${slug}`,
        onlyOnce: true,
      });
      emailSent = result.status === "sent" || result.status === "skipped";
    }

    return {
      campaignId,
      slug: String(campaign.slug),
      campaignStatus: nextStatus,
      forkupReviewStatus: String(campaign.forkup_review_status),
      businessTimingStatus: String(campaign.business_timing_status),
      emailSent,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
