import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import { toDateOnlyString } from "../lib/date-only";
import { CHANGE_REQUEST_MESSAGE_SELECT } from "../lib/change-request-message";
import { evaluateCampaignInvitationPhase } from "../lib/invitations";
import {
  parseChangeRequestMessage,
  shiftCampaignDates,
} from "../lib/parse-change-request";
import {
  buildSettlementBusinessEmail,
  sendBusinessLifecycleBatch,
} from "../lib/business-lifecycle-emails";
import {
  parseSenderUserId,
  resolveOrgMemberSender,
  setCampaignInviteSenderUserId,
} from "../lib/invite-sender";
import {
  formatCampaignDateLabel,
} from "../lib/business-email-templates";
import { buildCampaignVisibility } from "../lib/campaign-visibility";
import type { CampaignStatus, MethodType } from "../types/campaign";
import { participantsRouter } from "./participants";
import { config } from "../config";
import {
  lockCampaignForSettlement,
  runSettlementPipeline,
  updateSettlementAchStatus,
} from "../lib/settlement-engine";
import {
  buildSettlementCalculationLines,
  normalizeCardFeePercent,
  normalizePlatformFeePercent,
} from "../lib/financial-calculations";

export const manageRouter = Router();

manageRouter.use("/campaigns/:slug/participants", participantsRouter);

const PARTNER_STATUS_PRIORITY: Record<string, number> = {
  changes_requested: 6,
  needs_info: 5,
  opened: 4,
  invited: 4,
  pending: 4,
  ready: 3,
  accepted: 3,
  live: 2,
  completed: 2,
  expired: 1,
  declined: 1,
};

type PartnerInviteRow = QueryResultRow & {
  id: number;
  acceptance_status: string;
  contact_email?: string | null;
  updated_at?: Date | string | null;
  change_request_message?: string | null;
};

function partnerEmailKey(row: PartnerInviteRow): string {
  const email = String(row.contact_email ?? "").trim().toLowerCase();
  return email.includes("@") ? email : `id:${row.id}`;
}

function pickBetterPartnerRow<T extends PartnerInviteRow>(a: T, b: T): T {
  const pA = PARTNER_STATUS_PRIORITY[String(a.acceptance_status)] ?? 0;
  const pB = PARTNER_STATUS_PRIORITY[String(b.acceptance_status)] ?? 0;
  let winner = pB > pA ? b : a;
  let other = pB > pA ? a : b;
  if (pB === pA) {
    const tA = new Date(String(a.updated_at ?? 0)).getTime();
    const tB = new Date(String(b.updated_at ?? 0)).getTime();
    winner = tB > tA ? b : a;
    other = tB > tA ? a : b;
  }
  const mergedMessage =
    winner.change_request_message?.trim() || other.change_request_message?.trim() || null;
  if (mergedMessage && mergedMessage !== winner.change_request_message) {
    return { ...winner, change_request_message: mergedMessage };
  }
  return winner;
}

/** One row per business email — prefer changes_requested, then pending, then newest. */
function dedupePartnerInvitations<T extends PartnerInviteRow>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = partnerEmailKey(row);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, row);
      continue;
    }
    best.set(key, pickBetterPartnerRow(existing, row));
  }
  return [...best.values()];
}

function mapPartnerInvitation(inv: QueryResultRow, campaignSlug: string) {
  return {
    id: inv.id,
    businessName: inv.business_name,
    businessEmail: inv.contact_email,
    locationName: inv.location_name,
    city: inv.city,
    state: inv.state,
    methodType: inv.method_type,
    methodName: inv.method_name,
    givebackPercentage: Number(inv.giveback_percentage),
    participationHours: inv.participation_hours,
    acceptanceStatus: inv.acceptance_status,
    inviteStatus: inv.invite_status ?? inv.acceptance_status,
    respondByDate: toDateOnlyString(inv.respond_by_date) ?? null,
    openedAt: inv.opened_at ?? null,
    setupStatus: inv.setup_status ?? "pending",
    marketingReadyStatus: inv.marketing_ready_status ?? "pending",
    settlementReadyStatus: inv.settlement_ready_status ?? "pending",
    messageToBusiness: inv.message_to_business ?? null,
    proposedTerms: inv.proposed_terms ?? null,
    changeRequestMessage: inv.change_request_message ?? null,
    invitedAt: inv.created_at,
    token: inv.token,
    acceptPath: inv.token ? `/?step=business-acceptance&token=${inv.token}` : null,
    reviewPath: `/?step=business-invite-flow&campaign=${campaignSlug}&invitation=${inv.id}`,
  };
}

type CampaignRow = QueryResultRow & {
  id: number;
  slug: string;
  campaign_name: string;
  campaign_status: CampaignStatus;
  campaign_goal: number;
  raised: number;
  supporters_going: number;
  expected_guests: number;
  verified_visits: number;
  organization_name: string;
  campaign_start_date: string | Date | null;
  campaign_end_date: string | Date | null;
  invitation_deadline: string | Date | null;
  event_date?: string | Date | null;
  business_timing_status?: string | null;
  forkup_review_status?: string | null;
  campaign_story?: string | null;
  cover_image_url?: string | null;
};

manageRouter.get("/campaigns/:slug", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<CampaignRow>(
      `SELECT c.id, c.slug, c.campaign_name, c.campaign_status, c.campaign_goal,
              c.raised, c.supporters_going, c.expected_guests, c.verified_visits,
              c.campaign_start_date, c.campaign_end_date, c.invitation_deadline,
              c.event_date, c.business_timing_status, c.forkup_review_status,
              c.campaign_story, c.cover_image_url,
              n.organization_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE c.slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];

    const { rows: methods } = await pool.query<QueryResultRow>(
      `SELECT id, method_type, method_name, method_status
       FROM campaign_methods WHERE campaign_id = $1 ORDER BY id`,
      [campaign.id],
    );

    const { rows: invitations } = await pool.query<QueryResultRow>(
      `SELECT
         cbl.id,
         cbl.acceptance_status,
         cbl.invite_status,
         cbl.giveback_percentage,
         cbl.participation_hours,
         cbl.respond_by_date,
         cbl.opened_at,
         cbl.setup_status,
         cbl.marketing_ready_status,
         cbl.settlement_ready_status,
         cbl.message_to_business,
         cbl.proposed_terms,
         cbl.created_at,
         cbl.updated_at,
         b.business_name,
         b.contact_email,
         bl.location_name,
         bl.city,
         bl.state,
         cm.method_type,
         cm.method_name,
         it.token,
         ${CHANGE_REQUEST_MESSAGE_SELECT}
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
       WHERE cbl.campaign_id = $1
       ORDER BY cbl.updated_at DESC, b.business_name, bl.location_name`,
      [campaign.id],
    );

    const uniqueInvitations = dedupePartnerInvitations(
      invitations as PartnerInviteRow[],
    );

    const { rows: donationStats } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM donations WHERE campaign_id = $1 AND donation_type = 'virtual'`,
      [campaign.id],
    );

    const { rows: nextSeRows } = await pool.query<QueryResultRow>(
      `SELECT id, title, scheduled_date, action_type
       FROM success_engine_actions
       WHERE campaign_id = $1
         AND status IN ('ready', 'draft', 'pending')
         AND (scheduled_date IS NULL OR scheduled_date >= CURRENT_DATE - INTERVAL '1 day')
       ORDER BY
         CASE WHEN scheduled_date IS NULL THEN 1 ELSE 0 END,
         scheduled_date ASC,
         id ASC
       LIMIT 1`,
      [campaign.id],
    );
    const nextSe = nextSeRows[0]
      ? {
          id: Number(nextSeRows[0].id),
          title: String(nextSeRows[0].title),
          scheduledDate: toDateOnlyString(nextSeRows[0].scheduled_date),
          actionType: String(nextSeRows[0].action_type),
        }
      : null;

    const methodTypes = methods.map((m) => m.method_type as MethodType);
    const mappedInvitations = uniqueInvitations.map((inv) =>
      mapPartnerInvitation(inv, campaign.slug),
    );
    const visibility = buildCampaignVisibility({
      methods: methodTypes,
      campaignStatus: String(campaign.campaign_status),
      businessTimingStatus: campaign.business_timing_status,
      forkupReviewStatus: campaign.forkup_review_status,
      eventDate: toDateOnlyString(campaign.event_date),
      endDate: toDateOnlyString(campaign.campaign_end_date),
      coverPresent: Boolean(String(campaign.cover_image_url || "").trim()),
      storyPresent: Boolean(String(campaign.campaign_story || "").trim()),
      partners: mappedInvitations.map((inv) => ({
        businessName: inv.businessName,
        acceptanceStatus: inv.acceptanceStatus,
        inviteStatus: inv.inviteStatus,
        respondByDate: inv.respondByDate,
        setupStatus: inv.setupStatus,
        settlementReadyStatus: inv.settlementReadyStatus,
      })),
      nextSuccessEngineAction: nextSe,
    });

    res.json({
      slug: campaign.slug,
      name: campaign.campaign_name,
      nonprofit: campaign.organization_name,
      status: campaign.campaign_status,
      goal: Number(campaign.campaign_goal),
      raised: Number(campaign.raised),
      supportersGoing: Number(campaign.supporters_going),
      expectedGuests: Number(campaign.expected_guests),
      verifiedVisits: Number(campaign.verified_visits),
      startDate: toDateOnlyString(campaign.campaign_start_date),
      endDate: toDateOnlyString(campaign.campaign_end_date),
      eventDate: toDateOnlyString(campaign.event_date),
      invitationDeadline: toDateOnlyString(campaign.invitation_deadline),
      businessTimingStatus: campaign.business_timing_status ?? "ok",
      forkupReviewStatus: campaign.forkup_review_status ?? "none",
      methods: methods.map((m) => ({
        id: m.id,
        methodType: m.method_type,
        methodName: m.method_name,
        methodStatus: m.method_status,
      })),
      invitations: mappedInvitations,
      virtualDonations: {
        count: Number(donationStats[0]?.count ?? 0),
        total: Number(donationStats[0]?.total ?? 0),
      },
      visibility,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaign dashboard" });
  }
});

manageRouter.get("/campaigns/:slug/invitations/:invitationId", async (req, res) => {
  try {
    const invitationId = Number(req.params.invitationId);
    if (!invitationId) {
      res.status(400).json({ error: "Invalid invitation id" });
      return;
    }

    const { rows: rows } = await pool.query<QueryResultRow>(
      `SELECT
         cbl.id,
         cbl.acceptance_status,
         cbl.invite_status,
         cbl.giveback_percentage,
         cbl.participation_hours,
         cbl.respond_by_date,
         cbl.opened_at,
         cbl.setup_status,
         cbl.marketing_ready_status,
         cbl.settlement_ready_status,
         cbl.message_to_business,
         cbl.proposed_terms,
         cbl.created_at,
         cbl.updated_at,
         c.slug AS campaign_slug,
         c.campaign_name,
         b.business_name,
         b.contact_email,
         bl.location_name,
         bl.city,
         bl.state,
         cm.method_type,
         cm.method_name,
         it.token,
         ${CHANGE_REQUEST_MESSAGE_SELECT}
       FROM campaign_business_locations cbl
       JOIN campaigns c ON c.id = cbl.campaign_id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
       WHERE c.slug = $1 AND cbl.id = $2
       LIMIT 1`,
      [req.params.slug, invitationId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    res.json(mapPartnerInvitation(rows[0], req.params.slug));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invitation" });
  }
});

manageRouter.post("/campaigns/:slug/invitations/:invitationId/accept-changes", async (req, res) => {
  const connection = await pool.connect();
  try {
    const invitationId = Number(req.params.invitationId);
    if (!invitationId) {
      res.status(400).json({ error: "Invalid invitation id" });
      return;
    }

    await connection.query("BEGIN");

    const { rows: rows } = await connection.query<QueryResultRow>(
      `SELECT
         cbl.id,
         cbl.campaign_id,
         cbl.business_id,
         cbl.acceptance_status,
         b.contact_email,
         ba.change_request_message,
         c.campaign_start_date,
         c.campaign_end_date
       FROM campaign_business_locations cbl
       JOIN campaigns c ON c.id = cbl.campaign_id
       JOIN businesses b ON b.id = cbl.business_id
       LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
       WHERE c.slug = $1 AND cbl.id = $2
       LIMIT 1`,
      [req.params.slug, invitationId],
    );

    if (rows.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    const row = rows[0];
    if (String(row.acceptance_status) !== "changes_requested") {
      await connection.query("ROLLBACK");
      res.status(400).json({ error: "This invitation is not awaiting change review" });
      return;
    }

    const campaignId = Number(row.campaign_id);
    const businessId = Number(row.business_id);
    const contactEmail = String(row.contact_email ?? "").trim().toLowerCase();
    const changeMessage = String(row.change_request_message ?? "");
    const parsed = parseChangeRequestMessage(changeMessage);
    const preferredGiveback = parsed.preferredGiveback;

    if (parsed.preferredDate) {
      const { startDate, endDate } = shiftCampaignDates(
        parsed.preferredDate,
        row.campaign_start_date,
        row.campaign_end_date,
      );
      await connection.query(
        `UPDATE campaigns SET
          campaign_start_date = $1,
          campaign_end_date = COALESCE($2, campaign_end_date),
          updated_at = NOW()
         WHERE id = $3`,
        [startDate, endDate, campaignId],
      );
    }

    const { rows: siblings } = await connection.query<QueryResultRow>(
      `SELECT cbl.id
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       WHERE cbl.campaign_id = $1
         AND (
           cbl.business_id = $2
           OR ($3::text != '' AND LOWER(TRIM(b.contact_email)) = $4)
         )`,
      [campaignId, businessId, contactEmail, contactEmail],
    );

    for (const sibling of siblings) {
      const cblId = Number(sibling.id);
      await connection.query(
        `UPDATE campaign_business_locations SET
          acceptance_status = 'accepted',
          invite_status = 'accepted',
          giveback_percentage = COALESCE($1, giveback_percentage),
          updated_at = NOW()
         WHERE id = $2`,
        [preferredGiveback, cblId],
      );

      await connection.query(
        `INSERT INTO business_acceptances (
          campaign_business_location_id,
          authorized_representative,
          forkup_fee_acknowledged,
          net7_acknowledged,
          ach_authorized,
          accepted_at
        ) VALUES ($1, 'Accepted by nonprofit', TRUE, TRUE, TRUE, NOW())
         ON CONFLICT (campaign_business_location_id) DO UPDATE SET
          accepted_at = NOW(),
          updated_at = NOW()`,
        [cblId],
      );
    }

    await evaluateCampaignInvitationPhase(connection, campaignId);
    await connection.query("COMMIT");

    const { rows: updatedCampaign } = await connection.query<QueryResultRow>(
      `SELECT campaign_start_date, campaign_end_date FROM campaigns WHERE id = $1 LIMIT 1`,
      [campaignId],
    );
    const updated = updatedCampaign[0];

    res.json({
      success: true,
      acceptanceStatus: "accepted",
      campaignStartDate: toDateOnlyString(updated?.campaign_start_date) ?? null,
      campaignEndDate: toDateOnlyString(updated?.campaign_end_date) ?? null,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to accept requested changes" });
  } finally {
    connection.release();
  }
});

manageRouter.get("/campaigns", async (req, res) => {
  try {
    // Promote scheduled campaigns whose start date has arrived.
    await pool.query(
      `UPDATE campaigns SET campaign_status = 'live', updated_at = NOW()
       WHERE campaign_status = 'ready_to_launch'
         AND campaign_start_date IS NOT NULL
         AND campaign_start_date <= CURRENT_DATE`,
    );

    const nonprofitId = Number(req.query.nonprofitId);
    const params: number[] = [];
    let where = "";
    if (nonprofitId) {
      where = "WHERE c.nonprofit_id = $1";
      params.push(nonprofitId);
    }

    const { rows: rows } = await pool.query<CampaignRow>(
      `SELECT c.id, c.slug, c.campaign_name, c.campaign_status, c.campaign_goal,
              c.raised, c.supporters_going, c.verified_visits, c.campaign_start_date,
              c.campaign_end_date, c.business_timing_status, c.forkup_review_status,
              c.forkup_review_reason,
              n.organization_name,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_invited,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND cbl2.acceptance_status IN ('invited', 'pending', 'opened')
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_pending,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND cbl2.acceptance_status = 'changes_requested'
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_changes_requested,
              (SELECT COUNT(*)::int
               FROM campaign_business_locations cbl3
               WHERE cbl3.campaign_id = c.id
                 AND (
                   cbl3.setup_status = 'needs_info'
                   OR cbl3.settlement_ready_status = 'needs_info'
                   OR cbl3.invite_status = 'needs_info'
                 )) AS partners_needs_info
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       ${where}
       ORDER BY c.updated_at DESC`,
      params,
    );
    res.json(
      rows.map((r) => ({
        slug: r.slug,
        name: r.campaign_name,
        nonprofit: r.organization_name,
        status: r.campaign_status,
        goal: r.campaign_goal,
        raised: r.raised,
        supportersGoing: r.supporters_going,
        verifiedVisits: r.verified_visits,
        startDate: toDateOnlyString(r.campaign_start_date),
        endDate: toDateOnlyString(r.campaign_end_date),
        businessTimingStatus: r.business_timing_status ?? "ok",
        forkupReviewStatus: r.forkup_review_status ?? "none",
        forkupReviewReason:
          (r as QueryResultRow).forkup_review_reason != null
            ? String((r as QueryResultRow).forkup_review_reason)
            : null,
        partnersInvited: Number(r.partners_invited ?? 0),
        partnersPending: Number(r.partners_pending ?? 0),
        partnersChangesRequested: Number(r.partners_changes_requested ?? 0),
        partnersNeedsInfo: Number((r as QueryResultRow).partners_needs_info ?? 0),
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

manageRouter.get("/nonprofits/:nonprofitId/pending-invites", async (req, res) => {
  try {
    const nonprofitId = Number(req.params.nonprofitId);
    if (!nonprofitId) {
      res.status(400).json({ error: "Invalid nonprofit id" });
      return;
    }

    const { rows: businessRows } = await pool.query<QueryResultRow>(
      `SELECT
         nci.token,
         nci.invitation_status,
         nci.giveback_percentage,
         nci.sent_at,
         b.business_name,
         bl.location_name,
         c.campaign_name,
         c.slug AS campaign_slug,
         cm.method_name
       FROM nonprofit_campaign_invitations nci
       JOIN businesses b ON b.id = nci.business_id
       JOIN business_locations bl ON bl.id = nci.location_id
       JOIN campaigns c ON c.id = nci.campaign_id
       JOIN campaign_methods cm ON cm.id = nci.method_id
       WHERE nci.nonprofit_id = $1 AND nci.invitation_status = 'pending'
       ORDER BY nci.sent_at DESC`,
      [nonprofitId],
    );

    /** Additive: fundraiser → nonprofit campaign proposals (same dashboard list). */
    const { rows: fundraiserRows } = await pool.query<QueryResultRow>(
      `SELECT
         fci.token,
         fci.invitation_status,
         fci.sent_at,
         fci.fundraiser_name,
         fci.fundraiser_email,
         c.campaign_name,
         c.slug AS campaign_slug
       FROM fundraiser_campaign_invitations fci
       JOIN campaigns c ON c.id = fci.campaign_id
       WHERE fci.nonprofit_id = $1 AND fci.invitation_status = 'pending'
       ORDER BY fci.sent_at DESC`,
      [nonprofitId],
    );

    const businessInvites = businessRows.map((r) => ({
      token: r.token as string,
      inviteSource: "business" as const,
      businessName: r.business_name as string,
      locationName: r.location_name as string,
      fundraiserName: null as string | null,
      fundraiserEmail: null as string | null,
      campaignName: r.campaign_name as string,
      campaignSlug: r.campaign_slug as string,
      methodName: r.method_name as string,
      givebackPercentage: Number(r.giveback_percentage),
      sentAt: r.sent_at,
      acceptPath: `/?step=nonprofit-accepts-invite&token=${r.token}`,
    }));

    const fundraiserInvites = fundraiserRows.map((r) => ({
      token: r.token as string,
      inviteSource: "fundraiser" as const,
      businessName: (r.fundraiser_name as string) || "Fundraiser",
      locationName: "Fundraiser proposal",
      fundraiserName: (r.fundraiser_name as string) || null,
      fundraiserEmail: (r.fundraiser_email as string) || null,
      campaignName: r.campaign_name as string,
      campaignSlug: r.campaign_slug as string,
      methodName: "Fundraiser partnership",
      givebackPercentage: 0,
      sentAt: r.sent_at,
      acceptPath: `/?step=fundraiser-invite-accept&token=${r.token}`,
    }));

    const merged = [...businessInvites, ...fundraiserInvites].sort((a, b) => {
      const at = a.sentAt ? new Date(a.sentAt as string | Date).getTime() : 0;
      const bt = b.sentAt ? new Date(b.sentAt as string | Date).getTime() : 0;
      return bt - at;
    });

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch pending invitations" });
  }
});

manageRouter.get("/nonprofits/:nonprofitId/partner-updates", async (req, res) => {
  try {
    const nonprofitId = Number(req.params.nonprofitId);
    if (!nonprofitId) {
      res.status(400).json({ error: "Invalid nonprofit id" });
      return;
    }

    const { rows: rows } = await pool.query<QueryResultRow>(
      `SELECT
         cbl.id,
         cbl.acceptance_status,
         cbl.invite_status,
         cbl.giveback_percentage,
         cbl.respond_by_date,
         cbl.opened_at,
         cbl.setup_status,
         cbl.marketing_ready_status,
         cbl.settlement_ready_status,
         cbl.created_at,
         cbl.updated_at,
         c.slug AS campaign_slug,
         c.campaign_name,
         b.business_name,
         b.contact_email,
         bl.location_name,
         cm.method_name,
         ${CHANGE_REQUEST_MESSAGE_SELECT},
         it.token
       FROM campaign_business_locations cbl
       JOIN campaigns c ON c.id = cbl.campaign_id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
       LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       WHERE c.nonprofit_id = $1
         AND cbl.acceptance_status IN ('invited', 'pending', 'opened', 'changes_requested', 'needs_info')
       ORDER BY
         CASE cbl.acceptance_status
           WHEN 'changes_requested' THEN 0
           WHEN 'needs_info' THEN 1
           WHEN 'opened' THEN 2
           WHEN 'pending' THEN 3
           ELSE 4
         END,
         cbl.updated_at DESC`,
      [nonprofitId],
    );

    const unique = dedupePartnerInvitations(rows as PartnerInviteRow[]);

    res.json(
      unique.map((r) => ({
        id: r.id,
        acceptanceStatus: r.acceptance_status,
        inviteStatus: r.invite_status ?? r.acceptance_status,
        respondByDate: toDateOnlyString(r.respond_by_date) ?? null,
        openedAt: r.opened_at ?? null,
        setupStatus: r.setup_status ?? "pending",
        marketingReadyStatus: r.marketing_ready_status ?? "pending",
        settlementReadyStatus: r.settlement_ready_status ?? "pending",
        businessName: r.business_name,
        businessEmail: r.contact_email,
        locationName: r.location_name,
        campaignName: r.campaign_name,
        campaignSlug: r.campaign_slug,
        methodName: r.method_name,
        givebackPercentage: Number(r.giveback_percentage),
        changeRequestMessage: r.change_request_message ?? null,
        updatedAt: r.updated_at,
        reviewPath: `/?step=business-invite-flow&campaign=${r.campaign_slug}&invitation=${r.id}`,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch partner updates" });
  }
});

manageRouter.get("/campaigns/:slug/success-engine", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const { rows: actions } = await pool.query<QueryResultRow>(
      `SELECT id, action_type, channel, scheduled_date, title, content, status, completed_at,
              auto_send, sent_at, last_error
       FROM success_engine_actions WHERE campaign_id = $1 ORDER BY scheduled_date ASC, id ASC`,
      [campaigns[0].id],
    );

    res.json(
      actions.map((a) => ({
        id: a.id,
        actionType: a.action_type,
        channel: a.channel,
        scheduledDate: a.scheduled_date,
        title: a.title,
        content: a.content,
        status: a.status,
        completedAt: a.completed_at,
        autoSend: a.auto_send,
        sentAt: a.sent_at,
        lastError: a.last_error,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch success engine actions" });
  }
});

manageRouter.patch("/success-engine/:id", async (req, res) => {
  try {
    const { content, status, autoSend } = req.body as {
      content?: string;
      status?: string;
      autoSend?: boolean;
    };
    const updates: string[] = [];
    const params: unknown[] = [];

    if (content !== undefined) {
      params.push(content);
      updates.push(`content = $${params.length}`);
    }
    if (status && ["scheduled", "ready", "completed"].includes(status)) {
      params.push(status);
      updates.push(`status = $${params.length}`);
      if (status === "completed") updates.push("completed_at = NOW()");
    }
    if (typeof autoSend === "boolean") {
      params.push(autoSend);
      updates.push(`auto_send = $${params.length}`);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No updates provided" });
      return;
    }

    params.push(req.params.id);
    await pool.query(
      `UPDATE success_engine_actions SET ${updates.join(", ")} WHERE id = $${params.length}`,
      params,
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update action" });
  }
});

type SuccessAudience = "businesses" | "supporters" | "ambassadors" | "nonprofit";

const SUCCESS_AUDIENCE_BY_ACTION: Record<string, SuccessAudience> = {
  launch_email: "supporters",
  one_week_reminder: "supporters",
  mid_campaign_reminder: "supporters",
  final_push_reminder: "supporters",
  results_email: "supporters",
  receipt_reminder: "supporters",
  ambassador_recruitment: "ambassadors",
  guest_bartender_recruitment: "ambassadors",
  business_promotion: "businesses",
};

const SUCCESS_ROLE_BY_AUDIENCE: Record<SuccessAudience, "business" | "supporter" | "ambassador" | "nonprofit"> = {
  businesses: "business",
  supporters: "supporter",
  ambassadors: "ambassador",
  nonprofit: "nonprofit",
};

type SuccessRecipient = { email: string; name: string | null };

async function resolveSuccessRecipients(
  campaignId: number,
  audience: SuccessAudience,
): Promise<SuccessRecipient[]> {
  if (audience === "businesses") {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT DISTINCT LOWER(b.contact_email) AS email, b.business_name AS name
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       WHERE cbl.campaign_id = $1
         AND cbl.acceptance_status = 'accepted'
         AND b.contact_email LIKE '%@%'`,
      [campaignId],
    );
    return rows.map((r) => ({ email: String(r.email), name: r.name ?? null }));
  }

  if (audience === "ambassadors") {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT DISTINCT LOWER(email) AS email, MAX(name) AS name
       FROM campaign_participants
       WHERE campaign_id = $1 AND email LIKE '%@%'
       GROUP BY LOWER(email)`,
      [campaignId],
    );
    return rows.map((r) => ({ email: String(r.email), name: r.name ?? null }));
  }

  if (audience === "supporters") {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT DISTINCT LOWER(s.email) AS email, MAX(s.first_name) AS name
       FROM supporters s
       WHERE s.email LIKE '%@%'
         AND s.id IN (
           SELECT supporter_id FROM receipts WHERE campaign_id = $1 AND supporter_id IS NOT NULL
           UNION
           SELECT supporter_id FROM participation_intents WHERE campaign_id = $1
           UNION
           SELECT supporter_id FROM donations WHERE campaign_id = $1 AND supporter_id IS NOT NULL
         )
       GROUP BY LOWER(s.email)`,
      [campaignId],
    );
    return rows.map((r) => ({ email: String(r.email), name: r.name ?? null }));
  }

  const { rows } = await pool.query<QueryResultRow>(
    `SELECT LOWER(n.contact_email) AS email, n.contact_name AS name
     FROM campaigns c JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.id = $1 AND n.contact_email LIKE '%@%'`,
    [campaignId],
  );
  return rows.map((r) => ({ email: String(r.email), name: r.name ?? null }));
}

type DeliverableAction = {
  id: number;
  campaign_id: number;
  action_type: string;
  channel: string;
  title: string;
  content: string;
};

/**
 * Resolves recipients for an email success-engine action and sends it, logging
 * each send and marking the action completed when at least one email is sent.
 * Non-email channels are not delivered. Idempotent per action + recipient.
 */
async function deliverSuccessAction(
  action: DeliverableAction,
): Promise<{ sent: number; recipientCount: number; audience: SuccessAudience }> {
  const audience = SUCCESS_AUDIENCE_BY_ACTION[String(action.action_type)] ?? "nonprofit";
  const recipients = await resolveSuccessRecipients(Number(action.campaign_id), audience);

  let sent = 0;
  for (const recipient of recipients) {
    const result = await sendEmail({
      to: recipient.email,
      name: recipient.name,
      subject: String(action.title),
      body: String(action.content),
      emailType: `success_${action.action_type}`,
      campaignId: Number(action.campaign_id),
      stakeholderRole: SUCCESS_ROLE_BY_AUDIENCE[audience],
      relatedToken: `success-action:${action.id}:${recipient.email}`,
      onlyOnce: true,
    });
    if (result.status !== "failed") sent += 1;
  }

  if (sent > 0) {
    await pool.query(
      `UPDATE success_engine_actions
       SET status = 'completed', completed_at = NOW(), sent_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [action.id],
    );
  }

  return { sent, recipientCount: recipients.length, audience };
}

manageRouter.post("/success-engine/:id/send", async (req, res) => {
  try {
    const actionId = Number(req.params.id);
    if (!actionId) {
      res.status(400).json({ error: "Invalid action id" });
      return;
    }

    const { rows: actionRows } = await pool.query<QueryResultRow>(
      `SELECT sea.id, sea.campaign_id, sea.action_type, sea.channel,
              sea.title, sea.content, sea.status,
              c.campaign_name
       FROM success_engine_actions sea
       JOIN campaigns c ON c.id = sea.campaign_id
       WHERE sea.id = $1`,
      [actionId],
    );
    const action = actionRows[0];
    if (!action) {
      res.status(404).json({ error: "Action not found" });
      return;
    }

    if (action.channel !== "email") {
      res.status(400).json({
        error: `Only email actions can be sent right now (this action is '${action.channel}').`,
      });
      return;
    }

    const { sent, recipientCount, audience } = await deliverSuccessAction(
      action as DeliverableAction,
    );

    if (recipientCount === 0) {
      res.status(200).json({
        success: true,
        sent: 0,
        audience,
        message: `No ${audience} recipients found for this campaign yet — nothing was sent.`,
      });
      return;
    }

    res.json({ success: true, sent, audience });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send success engine action" });
  }
});

/**
 * Nick V2 Layer 5 — send business lifecycle emails 2/5/6/7 for a campaign.
 * Method: POST /api/manage/campaigns/:slug/business-emails
 * Body: {
 *   templateKey: 'invite_reminder' | 'missing_info' | 'launch_kit' | 'starting_soon',
 *   invitationId?: number,
 *   inviteSenderUserId?: number
 * }
 * Response: { success, sent, skipped, targeted, templateKey }
 */
manageRouter.post("/campaigns/:slug/business-emails", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").replace(/\/+$/, "");
    const { rows: campRows } = await pool.query<QueryResultRow>(
      `SELECT id, nonprofit_id FROM campaigns WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    const campaignId = Number(campRows[0]?.id);
    const nonprofitId = Number(campRows[0]?.nonprofit_id);
    if (!campaignId) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const body = req.body as {
      templateKey?: string;
      invitationId?: number;
      inviteSenderUserId?: number;
    };
    const allowed = ["invite_reminder", "missing_info", "launch_kit", "starting_soon"] as const;
    const templateKey = body.templateKey as (typeof allowed)[number] | undefined;
    if (!templateKey || !allowed.includes(templateKey)) {
      res.status(400).json({
        error: `templateKey must be one of: ${allowed.join(", ")}`,
      });
      return;
    }

    const senderId = parseSenderUserId(body.inviteSenderUserId);
    if (senderId != null && nonprofitId) {
      const headers = await resolveOrgMemberSender(
        "nonprofit",
        nonprofitId,
        senderId,
      );
      if (!headers) {
        res.status(400).json({
          error: "inviteSenderUserId must be a member of this nonprofit",
        });
        return;
      }
      await setCampaignInviteSenderUserId(campaignId, senderId);
    }

    const invitationId =
      typeof body.invitationId === "number" && Number.isFinite(body.invitationId)
        ? body.invitationId
        : undefined;

    const result = await sendBusinessLifecycleBatch({
      campaignId,
      templateKey,
      invitationId,
    });

    res.json({
      success: true,
      templateKey,
      ...result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send business lifecycle emails" });
  }
});

/**
 * Marks business invitations past their respond_by_date as expired.
 * Method: POST /api/manage/invites/expire-due
 * Body: none
 * Response: { success, expiredCount }
 */
manageRouter.post("/invites/expire-due", async (_req, res) => {
  try {
    const { rowCount: cblCount } = await pool.query(
      `UPDATE campaign_business_locations
       SET
         acceptance_status = 'expired',
         invite_status = 'expired',
         updated_at = NOW()
       WHERE respond_by_date IS NOT NULL
         AND respond_by_date < CURRENT_DATE
         AND acceptance_status IN ('draft', 'invited', 'opened', 'pending')`,
    );
    const { rowCount: biCount } = await pool.query(
      `UPDATE business_invitations
       SET invitation_status = 'expired'
       WHERE respond_by_date IS NOT NULL
         AND respond_by_date < CURRENT_DATE
         AND invitation_status IN ('draft', 'sent', 'invited', 'opened')`,
    );
    res.json({
      success: true,
      expiredCount: Number(cblCount ?? 0),
      emailLedgerExpired: Number(biCount ?? 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to expire due invitations" });
  }
});

manageRouter.post("/success-engine/run-due", async (req, res) => {
  try {
    const { rows: dueActions } = await pool.query<QueryResultRow>(
      `SELECT sea.id, sea.campaign_id, sea.action_type, sea.channel, sea.title, sea.content
       FROM success_engine_actions sea
       WHERE sea.status = 'ready'
         AND sea.channel = 'email'
         AND sea.scheduled_date IS NOT NULL
         AND sea.scheduled_date <= CURRENT_DATE
       ORDER BY sea.scheduled_date ASC, sea.id ASC`,
    );

    const results = [];
    let totalSent = 0;
    for (const action of dueActions) {
      const { sent, recipientCount, audience } = await deliverSuccessAction(
        action as DeliverableAction,
      );
      totalSent += sent;
      results.push({
        actionId: Number(action.id),
        campaignId: Number(action.campaign_id),
        actionType: action.action_type,
        audience,
        recipientCount,
        sent,
      });
    }

    res.json({
      success: true,
      processed: dueActions.length,
      totalSent,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to run due success engine actions" });
  }
});

/**
 * Automation summary for a campaign: which actions are set to auto-send, what's
 * upcoming vs. already sent, plus the timestamp of the last automated sweep.
 * Read-only.
 */
manageRouter.get("/campaigns/:slug/automation", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows: actions } = await pool.query<QueryResultRow>(
      `SELECT id, action_type, title, scheduled_date, status, auto_send, sent_at, last_error,
              (auto_send = TRUE AND status = 'ready'
               AND scheduled_date IS NOT NULL AND scheduled_date <= CURRENT_DATE) AS is_due
       FROM success_engine_actions
       WHERE campaign_id = $1 AND auto_send = TRUE
       ORDER BY scheduled_date ASC NULLS LAST, id ASC`,
      [campaignId],
    );

    const { rows: lastRun } = await pool.query<QueryResultRow>(
      `SELECT id, trigger_source, actions_processed, emails_sent, ran_at
       FROM automation_runs ORDER BY ran_at DESC, id DESC LIMIT 1`,
    );

    res.json({
      automatedActions: actions.map((a) => ({
        id: a.id,
        actionType: a.action_type,
        title: a.title,
        scheduledDate: a.scheduled_date,
        status: a.status,
        autoSend: a.auto_send,
        sentAt: a.sent_at,
        lastError: a.last_error,
        isDue: a.is_due,
      })),
      lastRun: lastRun[0]
        ? {
            id: lastRun[0].id,
            triggerSource: lastRun[0].trigger_source,
            actionsProcessed: Number(lastRun[0].actions_processed),
            emailsSent: Number(lastRun[0].emails_sent),
            ranAt: lastRun[0].ran_at,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch automation summary" });
  }
});

/**
 * Automated sweep intended for an external scheduler (cron / EventBridge / Amplify
 * scheduled job). Gated by the `x-automation-secret` header matching AUTOMATION_SECRET.
 * Only processes actions explicitly flagged `auto_send = TRUE` that are ready and due.
 * Records one `automation_runs` row per invocation. Never sends unless configured.
 */
manageRouter.post("/automation/run-due", async (req, res) => {
  try {
    const secret = config.automationSecret;
    if (!secret) {
      res.status(503).json({
        error: "Automation is not configured. Set AUTOMATION_SECRET to enable this endpoint.",
      });
      return;
    }
    const provided = String(req.header("x-automation-secret") ?? "");
    if (provided !== secret) {
      res.status(401).json({ error: "Invalid or missing automation secret." });
      return;
    }

    const { rows: dueActions } = await pool.query<QueryResultRow>(
      `SELECT sea.id, sea.campaign_id, sea.action_type, sea.channel, sea.title, sea.content
       FROM success_engine_actions sea
       WHERE sea.auto_send = TRUE
         AND sea.status = 'ready'
         AND sea.channel = 'email'
         AND sea.scheduled_date IS NOT NULL
         AND sea.scheduled_date <= CURRENT_DATE
       ORDER BY sea.scheduled_date ASC, sea.id ASC`,
    );

    const results = [];
    let totalSent = 0;
    for (const action of dueActions) {
      const { sent, recipientCount, audience } = await deliverSuccessAction(
        action as DeliverableAction,
      );
      totalSent += sent;

      // deliverSuccessAction clears last_error on success; record failures here.
      if (sent === 0) {
        const reason =
          recipientCount === 0 ? "No recipients found for this audience yet." : "All email sends failed.";
        await pool.query(
          `UPDATE success_engine_actions SET last_error = $1 WHERE id = $2`,
          [reason, action.id],
        );
      }

      results.push({
        actionId: Number(action.id),
        campaignId: Number(action.campaign_id),
        actionType: action.action_type,
        audience,
        recipientCount,
        sent,
      });
    }

    await pool.query(
      `INSERT INTO automation_runs (trigger_source, actions_processed, emails_sent, notes)
       VALUES ('cron', $1, $2, $3)`,
      [
        dueActions.length,
        totalSent,
        dueActions.length === 0 ? "No due auto-send actions." : null,
      ],
    );

    res.json({
      success: true,
      processed: dueActions.length,
      totalSent,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to run automated success engine actions" });
  }
});

manageRouter.get("/campaigns/:slug/settlement", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, campaign_name, campaign_status, campaign_start_date, campaign_end_date,
              settlement_grace_days, settlement_closed_at, settlement_frozen_at,
              adjustment_window_end, platform_fee_percent, card_fee_percent, card_fee_fixed,
              bartender_tips, silent_auction
       FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];

    const { rows: settlements } = await pool.query<QueryResultRow>(
      `SELECT s.*, b.business_name, bl.location_name
       FROM settlements s
       LEFT JOIN businesses b ON b.id = s.business_id
       LEFT JOIN business_locations bl ON bl.id = s.location_id
       WHERE s.campaign_id = $1
       ORDER BY b.business_name, bl.location_name`,
      [campaign.id],
    );

    const { rows: receiptStats } = await pool.query<QueryResultRow>(
      `SELECT
         COUNT(*) AS total_receipts,
         SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved_receipts,
         SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending_receipts
       FROM receipts WHERE campaign_id = $1`,
      [campaign.id],
    );

    const businessReports = settlements.map((s) => ({
      id: s.id,
      businessName: s.business_name ?? (s.business_id == null ? "Online donations" : "Campaign total"),
      locationName: s.location_name ?? (s.business_id == null ? "Virtual" : "—"),
      eligibleSales: Number(s.eligible_sales),
      donationPercentage: Number(s.donation_percentage),
      donationPool: Number(s.donation_pool),
      givebackAmount: Number(s.giveback_amount ?? 0),
      forkupFee: Number(s.forkup_fee),
      netNonprofitAmount: Number(s.net_nonprofit_amount),
      stripeDonations: Number(s.stripe_donations ?? 0),
      stripeFee: Number(s.stripe_fee ?? 0),
      stripeNet: Number(s.stripe_net ?? 0),
      achDebitAmount: Number(s.ach_debit_amount ?? s.forkup_fee ?? 0),
      achStatus: s.ach_status ?? "pending",
      snapshotStatus: s.snapshot_status ?? "pending",
      pdfBusinessPath: s.pdf_business_path ?? null,
      pdfAchPath: s.pdf_ach_path ?? null,
      paymentStatus: s.payment_status,
      lockedAt: s.locked_at,
    }));

    const totals = businessReports.reduce(
      (acc, r) => ({
        eligibleSales: acc.eligibleSales + r.eligibleSales,
        donationPool: acc.donationPool + r.donationPool,
        forkupFee: acc.forkupFee + r.forkupFee,
        netNonprofitAmount: acc.netNonprofitAmount + r.netNonprofitAmount,
      }),
      { eligibleSales: 0, donationPool: 0, forkupFee: 0, netNonprofitAmount: 0 },
    );

    const { rows: donationRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
       FROM donations
       WHERE campaign_id = $1 AND donation_type = 'virtual'
         AND payment_status = 'completed'`,
      [campaign.id],
    );

    const { rows: auditRows } = await pool.query<QueryResultRow>(
      `SELECT action, details, created_at
       FROM settlement_audit_log
       WHERE campaign_id = $1
       ORDER BY created_at ASC, id ASC`,
      [campaign.id],
    );

    const { rows: achApprovalRows } = await pool.query<QueryResultRow>(
      `SELECT a.id, a.settlement_id, a.approval_type, a.amount, a.status,
              a.approved_at, a.approved_by_name, a.approval_token,
              b.business_name, bl.location_name
       FROM settlement_ach_approvals a
       JOIN settlements s ON s.id = a.settlement_id
       LEFT JOIN businesses b ON b.id = s.business_id
       LEFT JOIN business_locations bl ON bl.id = s.location_id
       WHERE a.campaign_id = $1
       ORDER BY a.created_at ASC`,
      [campaign.id],
    );

    const nonprofitPdf =
      settlements.find((s) => s.pdf_nonprofit_path)?.pdf_nonprofit_path ?? null;
    const internalPdf =
      settlements.find((s) => s.pdf_internal_path)?.pdf_internal_path ?? null;

    const platformPct = normalizePlatformFeePercent(
      campaign.platform_fee_percent != null ? Number(campaign.platform_fee_percent) : null,
    );
    const cardPct = normalizeCardFeePercent(
      campaign.card_fee_percent != null ? Number(campaign.card_fee_percent) : null,
    );
    const cardFixed =
      campaign.card_fee_fixed != null && Number(campaign.card_fee_fixed) >= 0
        ? Number(campaign.card_fee_fixed)
        : 0.3;

    const businessRows = businessReports.filter((r) => r.businessName !== "Online donations");
    const onlineRow = businessReports.find((r) => r.businessName === "Online donations");

    const businessEligible = businessRows.reduce((sum, r) => sum + r.eligibleSales, 0);
    const businessGrossGiveback = businessRows.reduce(
      (sum, r) => sum + Number(r.givebackAmount ?? r.donationPool),
      0,
    );
    const businessForkupFee = businessRows.reduce((sum, r) => sum + r.forkupFee, 0);
    const businessNet = businessRows.reduce((sum, r) => sum + r.netNonprofitAmount, 0);
    const achDebitTotal = businessRows.reduce(
      (sum, r) => sum + Number(r.achDebitAmount ?? r.forkupFee),
      0,
    );
    const achOutstanding = businessRows
      .filter((r) => (r.achStatus ?? "pending") !== "paid")
      .reduce((sum, r) => sum + Number(r.achDebitAmount ?? r.forkupFee), 0);

    const onlineGross = onlineRow
      ? Number(onlineRow.stripeDonations ?? 0)
      : Number(donationRows[0]?.total ?? 0);
    const onlineCardFee = onlineRow ? Number(onlineRow.stripeFee ?? 0) : 0;
    const onlineNet = onlineRow ? Number(onlineRow.stripeNet ?? 0) : 0;
    const onlineCount = Number(donationRows[0]?.cnt ?? 0);

    const weightedGivebackPct =
      businessEligible > 0
        ? Math.round((businessGrossGiveback / businessEligible) * 10000) / 100
        : 0;

    const { lines: calculationLines } = buildSettlementCalculationLines({
      eligibleSales: businessEligible,
      givebackPercentage: weightedGivebackPct,
      platformFeePercent: platformPct,
      stripeDonations: onlineGross,
      stripeAmountCharged: onlineGross,
      stripeDonationCount: onlineCount,
      cardFeePercent: cardPct,
      cardFeeFixed: cardFixed,
    });

    const calculationReview = {
      platformFeePercent: platformPct,
      cardFeePercent: cardPct,
      cardFeeFixed: cardFixed,
      business: {
        eligibleSales: businessEligible,
        grossGiveback: businessGrossGiveback,
        forkupFee: businessForkupFee,
        netFromGiveback: businessNet,
        achDebitTotal,
        amountOwedByBusiness: achOutstanding,
      },
      online:
        onlineGross > 0
          ? {
              donationsGross: onlineGross,
              cardProcessingFee: onlineCardFee,
              netAfterFees: onlineNet,
              amountOwedToNonprofit: onlineNet,
              donationCount: onlineCount,
            }
          : null,
      totals: {
        donationPool: totals.donationPool,
        forkupFee: totals.forkupFee,
        netToNonprofit: totals.netNonprofitAmount,
        outstandingBusinessAch: achOutstanding,
        outstandingNonprofitPayout: onlineNet,
      },
      lines: calculationLines,
    };

    res.json({
      campaign: {
        name: campaign.campaign_name,
        status: campaign.campaign_status,
        startDate: toDateOnlyString(campaign.campaign_start_date),
        endDate: toDateOnlyString(campaign.campaign_end_date),
        isLocked: campaign.campaign_status === "settlement",
        graceDays: Number(campaign.settlement_grace_days ?? 7),
        closedAt: campaign.settlement_closed_at ?? null,
        frozenAt: campaign.settlement_frozen_at ?? null,
        adjustmentWindowEnd: campaign.adjustment_window_end ?? null,
        platformFeePercent:
          campaign.platform_fee_percent != null ? Number(campaign.platform_fee_percent) : null,
        cardFeePercent: campaign.card_fee_percent != null ? Number(campaign.card_fee_percent) : null,
        cardFeeFixed: campaign.card_fee_fixed != null ? Number(campaign.card_fee_fixed) : null,
        bartenderTips: Number(campaign.bartender_tips ?? 0),
        silentAuction: Number(campaign.silent_auction ?? 0),
      },
      pipeline: {
        closed: Boolean(campaign.settlement_closed_at),
        frozen: Boolean(campaign.settlement_frozen_at),
        snapshot: settlements.some((s) => s.snapshot_created_at),
        statementsSent: auditRows.some((a) => a.action === "SETTLEMENT_EMAIL_SENT"),
      },
      statements: {
        nonprofitPdf,
        internalPdf,
      },
      auditLog: auditRows.map((a) => ({
        action: a.action,
        details: a.details,
        at: a.created_at,
      })),
      receiptStats: {
        total: Number(receiptStats[0]?.total_receipts ?? 0),
        approved: Number(receiptStats[0]?.approved_receipts ?? 0),
        pending: Number(receiptStats[0]?.pending_receipts ?? 0),
      },
      businessReports,
      nonprofitReport: totals,
      onlineDonations: {
        count: Number(donationRows[0]?.cnt ?? 0),
        total: Number(donationRows[0]?.total ?? 0),
      },
      achApprovals: achApprovalRows.map((a) => ({
        id: Number(a.id),
        settlementId: Number(a.settlement_id),
        approvalType: a.approval_type,
        amount: Number(a.amount ?? 0),
        status: a.status,
        approvedAt: a.approved_at ?? null,
        approvedByName: a.approved_by_name ?? null,
        businessName: a.business_name ?? null,
        locationName: a.location_name ?? null,
      })),
      calculationReview,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch settlement report" });
  }
});

/** Aggregated analytics for a campaign — receipt/donation performance, a
 *  business leaderboard, and a daily timeline. Read-only. */
manageRouter.get("/campaigns/:slug/analytics", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, campaign_name, campaign_status, campaign_goal, raised
       FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaign = campaigns[0];
    const campaignId = Number(campaign.id);

    const { rows: totalsRows } = await pool.query<QueryResultRow>(
      `SELECT
         COUNT(*) AS receipts_uploaded,
         COUNT(*) FILTER (WHERE review_status = 'approved') AS receipts_approved,
         COUNT(*) FILTER (WHERE review_status = 'pending') AS receipts_pending,
         COUNT(*) FILTER (WHERE review_status = 'rejected') AS receipts_rejected,
         COALESCE(SUM(eligible_subtotal) FILTER (WHERE review_status = 'approved'), 0) AS eligible_sales,
         COALESCE(SUM(calculated_donation) FILTER (WHERE review_status = 'approved'), 0) AS donation_pool,
         COALESCE(AVG(calculated_donation) FILTER (WHERE review_status = 'approved'), 0) AS avg_contribution,
         COUNT(DISTINCT supporter_id) AS supporters
       FROM receipts WHERE campaign_id = $1`,
      [campaignId],
    );
    const t = totalsRows[0] ?? {};

    const { rows: donationRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
       FROM donations WHERE campaign_id = $1 AND donation_type = 'virtual'`,
      [campaignId],
    );

    const { rows: leaderboard } = await pool.query<QueryResultRow>(
      `SELECT
         r.business_id,
         r.location_id,
         b.business_name,
         bl.location_name,
         COUNT(*) FILTER (WHERE r.review_status = 'approved') AS approved_receipts,
         COALESCE(SUM(r.eligible_subtotal) FILTER (WHERE r.review_status = 'approved'), 0) AS eligible_sales,
         COALESCE(SUM(r.calculated_donation) FILTER (WHERE r.review_status = 'approved'), 0) AS donation_pool
       FROM receipts r
       LEFT JOIN businesses b ON b.id = r.business_id
       LEFT JOIN business_locations bl ON bl.id = r.location_id
       WHERE r.campaign_id = $1
       GROUP BY r.business_id, r.location_id, b.business_name, bl.location_name
       ORDER BY donation_pool DESC`,
      [campaignId],
    );

    const { rows: timeline } = await pool.query<QueryResultRow>(
      `SELECT
         to_char(date_trunc('day', COALESCE(approved_at, uploaded_at)), 'YYYY-MM-DD') AS day,
         COUNT(*) AS receipts,
         COALESCE(SUM(calculated_donation) FILTER (WHERE review_status = 'approved'), 0) AS donation_pool
       FROM receipts
       WHERE campaign_id = $1
       GROUP BY 1
       ORDER BY 1`,
      [campaignId],
    );

    res.json({
      campaign: {
        name: campaign.campaign_name,
        status: campaign.campaign_status,
        goal: Number(campaign.campaign_goal),
        raised: Number(campaign.raised),
      },
      totals: {
        receiptsUploaded: Number(t.receipts_uploaded ?? 0),
        receiptsApproved: Number(t.receipts_approved ?? 0),
        receiptsPending: Number(t.receipts_pending ?? 0),
        receiptsRejected: Number(t.receipts_rejected ?? 0),
        eligibleSales: Number(t.eligible_sales ?? 0),
        donationPool: Number(t.donation_pool ?? 0),
        averageContribution: Number(t.avg_contribution ?? 0),
        supporters: Number(t.supporters ?? 0),
        onlineDonationCount: Number(donationRows[0]?.cnt ?? 0),
        onlineDonationTotal: Number(donationRows[0]?.total ?? 0),
      },
      businessLeaderboard: leaderboard.map((r) => ({
        businessId: r.business_id ?? null,
        locationId: r.location_id ?? null,
        businessName: r.business_name ?? "Unknown business",
        locationName: r.location_name ?? "—",
        approvedReceipts: Number(r.approved_receipts ?? 0),
        eligibleSales: Number(r.eligible_sales ?? 0),
        donationPool: Number(r.donation_pool ?? 0),
      })),
      timeline: timeline.map((r) => ({
        date: r.day,
        receipts: Number(r.receipts ?? 0),
        donationPool: Number(r.donation_pool ?? 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaign analytics" });
  }
});

manageRouter.delete("/campaigns/:slug", async (req, res) => {
  const connection = await pool.connect();
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    await connection.query("BEGIN");

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id, campaign_name FROM campaigns WHERE slug = $1",
      [slug],
    );
    if (campaigns.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    await connection.query("DELETE FROM campaigns WHERE id = $1", [campaigns[0].id]);
    await connection.query("COMMIT");
    res.json({ success: true, slug });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete campaign" });
  } finally {
    connection.release();
  }
});

manageRouter.post("/campaigns/:slug/go-live", async (req, res) => {
  const connection = await pool.connect();
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    await connection.query("BEGIN");

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id, campaign_status, campaign_start_date FROM campaigns WHERE slug = $1",
      [slug],
    );
    if (campaigns.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];
    const status = String(campaign.campaign_status);
    if (status !== "ready_to_launch") {
      await connection.query("ROLLBACK");
      res.status(400).json({
        error:
          status === "live"
            ? "Campaign is already live"
            : "Only scheduled campaigns can be published early",
      });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    await connection.query(
      `UPDATE campaigns SET
         campaign_status = 'live',
         campaign_start_date = CASE
           WHEN campaign_start_date IS NULL OR campaign_start_date > $1 THEN $2
           ELSE campaign_start_date
         END,
         updated_at = NOW()
       WHERE id = $3`,
      [today, today, campaign.id],
    );

    await connection.query("COMMIT");
    res.json({ success: true, status: "live", slug });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to publish campaign" });
  } finally {
    connection.release();
  }
});

function money(value: unknown): string {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

/**
 * Sends settlement notices after a campaign is locked: one per participating
 * business (fee + ACH deduction + net owed), one to the nonprofit (totals), and
 * an optional internal notice to FORKUP_ADMIN_EMAIL. Idempotent per campaign so
 * re-locking will not re-send. Uses the mailer, which never throws.
 */
async function sendSettlementEmails(campaignId: number): Promise<void> {
  const { rows: campaignRows } = await pool.query<QueryResultRow>(
    `SELECT c.campaign_name, c.slug, c.campaign_start_date, c.campaign_end_date, c.event_date,
            n.organization_name,
            n.contact_email AS nonprofit_email, n.contact_name AS nonprofit_contact
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.id = $1`,
    [campaignId],
  );
  const campaign = campaignRows[0];
  if (!campaign) return;

  const dateRangeLabel = formatCampaignDateLabel({
    startDate: toDateOnlyString(campaign.campaign_start_date),
    endDate: toDateOnlyString(campaign.campaign_end_date),
    eventDate: toDateOnlyString(campaign.event_date),
  });

  const { rows: bizRows } = await pool.query<QueryResultRow>(
    `SELECT s.business_id,
            b.business_name,
            b.contact_email,
            SUM(s.eligible_sales) AS eligible_sales,
            SUM(s.donation_pool) AS donation_pool,
            SUM(s.forkup_fee) AS forkup_fee,
            SUM(s.net_nonprofit_amount) AS net_nonprofit_amount,
            MAX(s.donation_percentage) AS donation_percentage,
            BOOL_AND(COALESCE(ba.ach_authorized, FALSE)) AS ach_authorized,
            MAX(ba.settlement_contact_email) AS settlement_contact_email,
            MAX(ba.billing_contact_email) AS billing_contact_email
     FROM settlements s
     JOIN businesses b ON b.id = s.business_id
     LEFT JOIN campaign_business_locations cbl
       ON cbl.campaign_id = s.campaign_id
       AND cbl.business_id = s.business_id
       AND (cbl.location_id = s.location_id OR s.location_id IS NULL)
     LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
     WHERE s.campaign_id = $1 AND s.business_id IS NOT NULL
     GROUP BY s.business_id, b.business_name, b.contact_email`,
    [campaignId],
  );

  const { rows: donationRows } = await pool.query<QueryResultRow>(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM donations
     WHERE campaign_id = $1 AND donation_type = 'virtual'`,
    [campaignId],
  );
  const onlineDonations = Number(donationRows[0]?.total ?? 0);

  const reportUrl = `${resolveFrontendBaseUrl()}/?step=reporting&campaign=${campaign.slug}`;
  const missingInfo: string[] = [];
  let totalNet = 0;
  let totalFee = 0;

  for (const row of bizRows) {
    const forkupFee = Number(row.forkup_fee ?? 0);
    const net = Number(row.net_nonprofit_amount ?? 0);
    totalNet += net;
    totalFee += forkupFee;

    const recipient =
      (typeof row.settlement_contact_email === "string" && row.settlement_contact_email.trim()) ||
      (typeof row.billing_contact_email === "string" && row.billing_contact_email.trim()) ||
      (typeof row.contact_email === "string" && row.contact_email.trim()) ||
      "";

    if (!row.ach_authorized) missingInfo.push(`${row.business_name}: ACH not authorized`);
    if (!recipient) {
      missingInfo.push(`${row.business_name}: no settlement contact email`);
      continue;
    }

    // Nick V2 Layer 5 Email 8 — settlement ready (keeps emailType settlement_business).
    const rendered = buildSettlementBusinessEmail({
      businessName: String(row.business_name),
      nonprofitName: String(campaign.organization_name),
      campaignTitle: String(campaign.campaign_name),
      dateRangeLabel,
      eligibleSales: Number(row.eligible_sales ?? 0),
      donationAmount: Number(row.donation_pool ?? 0),
      forkupFee,
      reportUrl,
    });
    await sendEmail({
      to: recipient,
      name: typeof row.business_name === "string" ? row.business_name : null,
      subject: rendered.subject,
      body: rendered.body,
      emailType: rendered.emailType,
      campaignId,
      stakeholderRole: "business",
      relatedToken: `settlement:${campaignId}:${row.business_id}`,
      onlyOnce: true,
    });
  }

  const nonprofitEmail =
    typeof campaign.nonprofit_email === "string" ? campaign.nonprofit_email.trim() : "";
  if (nonprofitEmail) {
    const businessList = bizRows.map((r) => `- ${r.business_name}: ${money(r.net_nonprofit_amount)}`).join("\n");
    await sendEmail({
      to: nonprofitEmail,
      name: typeof campaign.nonprofit_contact === "string" ? campaign.nonprofit_contact : null,
      subject: `Settlement ready for "${campaign.campaign_name}"`,
      body:
        `Hi ${campaign.organization_name},\n\n` +
        `Your ForkUp campaign "${campaign.campaign_name}" has closed. Here's your settlement summary:\n\n` +
        `Expected payment from businesses: ${money(totalNet)}\n` +
        `Online donations: ${money(onlineDonations)}\n` +
        `Total raised: ${money(totalNet + onlineDonations)}\n\n` +
        `Participating businesses:\n${businessList || "- (none)"}\n\n` +
        `Full report: ${reportUrl}\n\n` +
        `Thank you for fundraising with ForkUp.\n— ForkUp`,
      emailType: "settlement_nonprofit",
      campaignId,
      stakeholderRole: "nonprofit",
      relatedToken: `settlement:${campaignId}:nonprofit`,
      onlyOnce: true,
    });
  }

  const adminEmail = process.env.FORKUP_ADMIN_EMAIL?.trim();
  if (adminEmail) {
    await sendEmail({
      to: adminEmail,
      subject: `[Internal] Settlement locked — "${campaign.campaign_name}"`,
      body:
        `Campaign "${campaign.campaign_name}" (${campaign.organization_name}) has been locked for settlement.\n\n` +
        `Businesses settled: ${bizRows.length}\n` +
        `Total ForkUp fees (ACH): ${money(totalFee)}\n` +
        `Total net to nonprofit: ${money(totalNet)}\n` +
        `Online donations: ${money(onlineDonations)}\n\n` +
        (missingInfo.length
          ? `Manual review flags:\n${missingInfo.map((m) => `- ${m}`).join("\n")}\n\n`
          : `No missing-info flags.\n\n`) +
        `Report: ${reportUrl}\n`,
      emailType: "settlement_internal",
      campaignId,
      stakeholderRole: "admin",
      relatedToken: `settlement:${campaignId}:internal`,
      onlyOnce: true,
    });
  }
}

manageRouter.post("/campaigns/:slug/lock", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id, campaign_status FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaignId = Number(campaigns[0].id);
    await lockCampaignForSettlement(campaignId);
    res.json({ success: true, status: "settlement" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to lock campaign";
    if (message.includes("already locked")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Failed to lock campaign" });
  }
});

/**
 * Settlement engine sweep (same pipeline as the in-process worker).
 * Gated by x-automation-secret matching AUTOMATION_SECRET.
 */
manageRouter.post("/settlement/run-due", async (req, res) => {
  try {
    const secret = config.automationSecret;
    if (!secret) {
      res.status(503).json({
        error: "Automation is not configured. Set AUTOMATION_SECRET to enable this endpoint.",
      });
      return;
    }
    const provided = String(req.header("x-automation-secret") ?? "");
    if (provided !== secret) {
      res.status(401).json({ error: "Invalid or missing automation secret." });
      return;
    }
    const result = await runSettlementPipeline();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to run settlement pipeline" });
  }
});

manageRouter.patch("/campaigns/:slug/settlement-settings", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, settlement_frozen_at FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (campaigns[0].settlement_frozen_at) {
      res.status(400).json({ error: "Campaign is frozen. Fee and manual amounts cannot change." });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const toNullableFee = (value: unknown): number | null => {
      if (value === null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const toMoney = (value: unknown): number => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
    };

    await pool.query(
      `UPDATE campaigns SET
         platform_fee_percent = $1,
         card_fee_percent = $2,
         card_fee_fixed = $3,
         bartender_tips = $4,
         silent_auction = $5,
         updated_at = NOW()
       WHERE id = $6`,
      [
        toNullableFee(body.platformFeePercent),
        toNullableFee(body.cardFeePercent),
        toNullableFee(body.cardFeeFixed),
        toMoney(body.bartenderTips),
        toMoney(body.silentAuction),
        campaigns[0].id,
      ],
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save settlement settings" });
  }
});

manageRouter.patch("/campaigns/:slug/settlements/:id/ach-status", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const body = req.body as { achStatus?: string };
    const result = await updateSettlementAchStatus({
      campaignId: Number(campaigns[0].id),
      settlementId: Number(req.params.id),
      achStatus: String(body.achStatus ?? ""),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update ACH status";
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes("must be")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Failed to update ACH status" });
  }
});

const PAYOUT_TYPES = ["business_to_forkup", "forkup_to_nonprofit", "adjustment"];
const PAYOUT_STATUSES = ["pending", "processing", "paid", "failed", "cancelled"];
const PAYOUT_METHODS = ["ach", "check", "manual", "other"];

function mapPayout(row: QueryResultRow) {
  return {
    id: row.id,
    payoutType: row.payout_type,
    amount: Number(row.amount),
    status: row.status,
    method: row.method ?? null,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    settlementId: row.settlement_id ?? null,
    businessId: row.business_id ?? null,
    locationId: row.location_id ?? null,
    businessName: row.business_name ?? null,
    locationName: row.location_name ?? null,
    initiatedAt: row.initiated_at ?? null,
    paidAt: row.paid_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Disbursement records for a campaign (business→ForkUp and ForkUp→nonprofit). */
manageRouter.get("/campaigns/:slug/payouts", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT p.*, b.business_name, bl.location_name
       FROM payouts p
       LEFT JOIN businesses b ON b.id = p.business_id
       LEFT JOIN business_locations bl ON bl.id = p.location_id
       WHERE p.campaign_id = $1
       ORDER BY p.created_at DESC`,
      [campaignId],
    );

    const payouts = rows.map(mapPayout);
    const summary = payouts.reduce(
      (acc, p) => {
        if (p.status === "paid") acc.totalPaid += p.amount;
        else if (p.status !== "cancelled" && p.status !== "failed") acc.totalPending += p.amount;
        return acc;
      },
      { totalPaid: 0, totalPending: 0 },
    );

    res.json({ payouts, summary: { ...summary, count: payouts.length } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

/** Record a new payout/disbursement for a campaign. */
manageRouter.post("/campaigns/:slug/payouts", async (req, res) => {
  try {
    const {
      payoutType,
      amount,
      status,
      method,
      reference,
      notes,
      settlementId,
      businessId,
      locationId,
    } = req.body as Record<string, unknown>;

    const type = typeof payoutType === "string" ? payoutType : "forkup_to_nonprofit";
    if (!PAYOUT_TYPES.includes(type)) {
      res.status(400).json({ error: "Invalid payout type" });
      return;
    }
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: "Amount must be greater than zero" });
      return;
    }
    const statusValue = typeof status === "string" && status ? status : "pending";
    if (!PAYOUT_STATUSES.includes(statusValue)) {
      res.status(400).json({ error: "Invalid payout status" });
      return;
    }
    const methodValue = typeof method === "string" && method ? method : null;
    if (methodValue !== null && !PAYOUT_METHODS.includes(methodValue)) {
      res.status(400).json({ error: "Invalid payout method" });
      return;
    }

    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows } = await pool.query<QueryResultRow>(
      `INSERT INTO payouts (
        campaign_id, settlement_id, business_id, location_id,
        payout_type, amount, status, method, reference, notes,
        initiated_at, paid_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(),
        CASE WHEN $7::varchar = 'paid' THEN NOW() ELSE NULL END)
      RETURNING *`,
      [
        campaignId,
        settlementId != null ? Number(settlementId) : null,
        businessId != null ? Number(businessId) : null,
        locationId != null ? Number(locationId) : null,
        type,
        amountNum,
        statusValue,
        methodValue,
        typeof reference === "string" && reference.trim() ? reference.trim() : null,
        typeof notes === "string" && notes.trim() ? notes.trim() : null,
      ],
    );

    res.status(201).json(mapPayout(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payout" });
  }
});

/** Update a payout's status/details. Marking 'paid' stamps paid_at and, when the
 *  payout is linked to a settlement, advances that settlement's payment_status. */
manageRouter.patch("/campaigns/:slug/payouts/:id", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { status, method, reference, notes } = req.body as Record<string, unknown>;

    if (typeof status !== "string" || !PAYOUT_STATUSES.includes(status)) {
      res.status(400).json({ error: "Invalid payout status" });
      return;
    }
    const methodValue = typeof method === "string" && method ? method : null;
    if (methodValue !== null && !PAYOUT_METHODS.includes(methodValue)) {
      res.status(400).json({ error: "Invalid payout method" });
      return;
    }

    await connection.query("BEGIN");

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows } = await connection.query<QueryResultRow>(
      `UPDATE payouts SET
         status = $1,
         method = COALESCE($2, method),
         reference = COALESCE($3, reference),
         notes = COALESCE($4, notes),
         paid_at = CASE WHEN $1::varchar = 'paid' AND paid_at IS NULL THEN NOW() ELSE paid_at END
       WHERE id = $5 AND campaign_id = $6
       RETURNING *`,
      [
        status,
        methodValue,
        typeof reference === "string" && reference.trim() ? reference.trim() : null,
        typeof notes === "string" && notes.trim() ? notes.trim() : null,
        Number(req.params.id),
        campaignId,
      ],
    );

    if (rows.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Payout not found" });
      return;
    }

    const payout = rows[0];
    // When a nonprofit disbursement is paid and tied to a settlement row, reflect it there.
    if (
      status === "paid" &&
      payout.settlement_id != null &&
      payout.payout_type === "forkup_to_nonprofit"
    ) {
      await connection.query(
        `UPDATE settlements SET payment_status = 'paid' WHERE id = $1`,
        [Number(payout.settlement_id)],
      );
    }

    await connection.query("COMMIT");
    res.json(mapPayout(payout));
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update payout" });
  } finally {
    connection.release();
  }
});

manageRouter.get("/email-log", async (req, res) => {
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const campaignSlug =
      typeof req.query.campaign === "string" ? req.query.campaign.trim() : "";
    if (campaignSlug) {
      params.push(campaignSlug);
      conditions.push(`c.slug = $${params.length}`);
    }

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    if (status) {
      params.push(status);
      conditions.push(`el.status = $${params.length}`);
    }

    const emailType = typeof req.query.type === "string" ? req.query.type.trim() : "";
    if (emailType) {
      params.push(emailType);
      conditions.push(`el.email_type = $${params.length}`);
    }

    const role = typeof req.query.role === "string" ? req.query.role.trim() : "";
    if (role) {
      params.push(role);
      conditions.push(`el.stakeholder_role = $${params.length}`);
    }

    const requestedLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 500)
        : 100;
    params.push(limit);
    const limitParam = `$${params.length}`;

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT el.id, el.campaign_id, c.slug AS campaign_slug, c.campaign_name,
              el.recipient_email, el.recipient_name, el.stakeholder_role,
              el.email_type, el.subject, el.provider, el.provider_message_id,
              el.status, el.error_message, el.related_token, el.created_at
       FROM email_log el
       LEFT JOIN campaigns c ON c.id = el.campaign_id
       ${where}
       ORDER BY el.id DESC
       LIMIT ${limitParam}`,
      params,
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        campaignId: r.campaign_id,
        campaignSlug: r.campaign_slug,
        campaignName: r.campaign_name,
        recipientEmail: r.recipient_email,
        recipientName: r.recipient_name,
        stakeholderRole: r.stakeholder_role,
        emailType: r.email_type,
        subject: r.subject,
        provider: r.provider,
        providerMessageId: r.provider_message_id,
        status: r.status,
        errorMessage: r.error_message,
        relatedToken: r.related_token,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch email log" });
  }
});

// ─── Trust validation: admin access-request review queue ─────────────────────
// The nonprofit claim-request engine (routes/profiles.ts) triages incoming
// claims/access requests into low/medium/high risk and writes them to
// organization_access_requests (status 'pending'), parking medium-risk claims
// at verification_status='needs_review'. These endpoints let a ForkUp admin
// list that queue and approve/deny requests to complete verification. All
// writes are additive: request rows are updated in place and, on approval, the
// target organization is marked verified and/or the requester is linked.

const ACCESS_REQUEST_STATUSES = new Set(["pending", "approved", "denied"]);
const ACCESS_REQUEST_RISK_LEVELS = new Set(["low", "medium", "high"]);

manageRouter.get("/access-requests", async (req, res) => {
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    if (status) {
      if (!ACCESS_REQUEST_STATUSES.has(status)) {
        res
          .status(400)
          .json({ error: "status must be one of: pending, approved, denied" });
        return;
      }
      params.push(status);
      conditions.push(`ar.status = $${params.length}`);
    }

    const riskLevel =
      typeof req.query.riskLevel === "string" ? req.query.riskLevel.trim() : "";
    if (riskLevel) {
      if (!ACCESS_REQUEST_RISK_LEVELS.has(riskLevel)) {
        res.status(400).json({ error: "riskLevel must be one of: low, medium, high" });
        return;
      }
      params.push(riskLevel);
      conditions.push(`ar.risk_level = $${params.length}`);
    }

    const organizationType =
      typeof req.query.organizationType === "string"
        ? req.query.organizationType.trim()
        : "";
    if (organizationType) {
      if (organizationType !== "nonprofit" && organizationType !== "business") {
        res
          .status(400)
          .json({ error: "organizationType must be one of: nonprofit, business" });
        return;
      }
      params.push(organizationType);
      conditions.push(`ar.organization_type = $${params.length}`);
    }

    const requestedLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 500)
        : 100;
    params.push(limit);
    const limitParam = `$${params.length}`;

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT ar.id, ar.organization_type, ar.organization_id, ar.organization_name,
              ar.request_type, ar.risk_level, ar.status, ar.requested_by_user_id,
              ar.requester_name, ar.requester_email, ar.relationship, ar.risk_reason,
              ar.reviewed_by_user_id, ar.reviewed_at, ar.review_notes,
              ar.created_at, ar.updated_at,
              COALESCE(n.slug, b.slug) AS organization_slug
       FROM organization_access_requests ar
       LEFT JOIN nonprofits n
         ON ar.organization_type = 'nonprofit' AND n.id = ar.organization_id
       LEFT JOIN businesses b
         ON ar.organization_type = 'business' AND b.id = ar.organization_id
       ${where}
       ORDER BY ar.id DESC
       LIMIT ${limitParam}`,
      params,
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        organizationType: r.organization_type,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        organizationSlug: r.organization_slug,
        requestType: r.request_type,
        riskLevel: r.risk_level,
        status: r.status,
        requestedByUserId: r.requested_by_user_id,
        requesterName: r.requester_name,
        requesterEmail: r.requester_email,
        relationship: r.relationship,
        riskReason: r.risk_reason,
        reviewedByUserId: r.reviewed_by_user_id,
        reviewedAt: r.reviewed_at,
        reviewNotes: r.review_notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch access requests" });
  }
});

/** Shared parser for approve/deny bodies. */
function parseReviewBody(body: unknown): {
  reviewedByUserId: number | null;
  notes: string | null;
} {
  const b = (body ?? {}) as { reviewedByUserId?: number | string; notes?: string };
  const rawId = Number(b.reviewedByUserId);
  const reviewedByUserId = Number.isFinite(rawId) && rawId > 0 ? Math.floor(rawId) : null;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
  return { reviewedByUserId, notes };
}

/**
 * Emails the requester the outcome of their trust review. Best-effort: sendEmail
 * never throws and is called after the DB work, so it cannot affect the request.
 */
async function notifyRequesterOfReview(params: {
  requestId: number;
  decision: "approved" | "denied";
  requestType: string;
  organizationType: string;
  organizationName: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  notes: string | null;
}): Promise<void> {
  const email = params.requesterEmail?.trim();
  if (!email) return;

  const orgName = params.organizationName?.trim() || "your organization";
  const role: "nonprofit" | "business" =
    params.organizationType === "business" ? "business" : "nonprofit";
  const baseUrl = resolveFrontendBaseUrl();

  let subject: string;
  let body: string;
  if (params.decision === "approved") {
    subject = `Your request for ${orgName} was approved`;
    const outcomeLine =
      params.requestType === "access"
        ? `You now have access to ${orgName} on ForkUp.`
        : `${orgName} is now verified on ForkUp.`;
    body =
      `Hi ${params.requesterName?.trim() || "there"},\n\n` +
      `Good news — your ${params.requestType === "access" ? "access" : "claim"} request for ` +
      `${orgName} has been approved. ${outcomeLine}\n\n` +
      (params.notes ? `Note from the ForkUp team: ${params.notes}\n\n` : "") +
      `You can continue in ForkUp here: ${baseUrl}\n`;
  } else {
    subject = `Update on your request for ${orgName}`;
    body =
      `Hi ${params.requesterName?.trim() || "there"},\n\n` +
      `Thanks for your interest in ${orgName}. After review, we weren't able to ` +
      `approve this request at that time.\n\n` +
      (params.notes ? `Note from the ForkUp team: ${params.notes}\n\n` : "") +
      `If you believe this was a mistake or have more information, please reply to this email.\n`;
  }

  await sendEmail({
    to: email,
    name: params.requesterName ?? null,
    subject,
    body,
    emailType: params.decision === "approved" ? "trust_request_approved" : "trust_request_denied",
    stakeholderRole: role,
    relatedToken: `access-request:${params.requestId}`,
    onlyOnce: true,
  });
}

manageRouter.post("/access-requests/:id/approve", async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  const { reviewedByUserId, notes } = parseReviewBody(req.body);

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows } = await connection.query<QueryResultRow>(
      `SELECT id, organization_type, organization_id, request_type, requested_by_user_id,
              organization_name, requester_email, requester_name
       FROM organization_access_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const request = rows[0];
    if (!request) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Access request not found" });
      return;
    }

    await connection.query(
      `UPDATE organization_access_requests
       SET status = 'approved', reviewed_by_user_id = $1, reviewed_at = NOW(),
           review_notes = $2, updated_at = NOW()
       WHERE id = $3`,
      [reviewedByUserId, notes, requestId],
    );

    const orgType = String(request.organization_type);
    const orgId = request.organization_id != null ? Number(request.organization_id) : null;
    const requestType = String(request.request_type);
    const requesterUserId =
      request.requested_by_user_id != null ? Number(request.requested_by_user_id) : null;

    if (requestType === "claim" && orgId) {
      if (orgType === "nonprofit") {
        await connection.query(
          `UPDATE nonprofits
           SET verification_status = 'verified', profile_status = 'verified',
               verification_date = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [orgId],
        );
      } else if (orgType === "business") {
        await connection.query(
          `UPDATE businesses
           SET claim_status = 'verified', verification_date = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [orgId],
        );
      }
    }

    if (requestType === "access" && orgId && requesterUserId) {
      await connection.query(
        `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
         VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
        [orgType, orgId, requesterUserId],
      );
    }

    await connection.query("COMMIT");

    await notifyRequesterOfReview({
      requestId,
      decision: "approved",
      requestType,
      organizationType: orgType,
      organizationName: request.organization_name ? String(request.organization_name) : null,
      requesterEmail: request.requester_email ? String(request.requester_email) : null,
      requesterName: request.requester_name ? String(request.requester_name) : null,
      notes,
    });

    res.json({ success: true, id: requestId, status: "approved" });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to approve access request" });
  } finally {
    connection.release();
  }
});

manageRouter.post("/access-requests/:id/deny", async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  const { reviewedByUserId, notes } = parseReviewBody(req.body);

  try {
    const { rows } = await pool.query<QueryResultRow>(
      `UPDATE organization_access_requests
       SET status = 'denied', reviewed_by_user_id = $1, reviewed_at = NOW(),
           review_notes = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, organization_type, request_type, organization_name,
                 requester_email, requester_name`,
      [reviewedByUserId, notes, requestId],
    );
    const request = rows[0];
    if (!request) {
      res.status(404).json({ error: "Access request not found" });
      return;
    }

    await notifyRequesterOfReview({
      requestId,
      decision: "denied",
      requestType: String(request.request_type),
      organizationType: String(request.organization_type),
      organizationName: request.organization_name ? String(request.organization_name) : null,
      requesterEmail: request.requester_email ? String(request.requester_email) : null,
      requesterName: request.requester_name ? String(request.requester_name) : null,
      notes,
    });

    res.json({ success: true, id: requestId, status: "denied" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deny access request" });
  }
});
