import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { toDateOnlyString } from "../lib/date-only";
import { CHANGE_REQUEST_MESSAGE_SELECT } from "../lib/change-request-message";
import { evaluateCampaignInvitationPhase } from "../lib/invitations";
import {
  parseChangeRequestMessage,
  shiftCampaignDates,
} from "../lib/parse-change-request";
import type { CampaignStatus } from "../types/campaign";
import { participantsRouter } from "./participants";

export const manageRouter = Router();

manageRouter.use("/campaigns/:slug/participants", participantsRouter);

const PARTNER_STATUS_PRIORITY: Record<string, number> = {
  changes_requested: 5,
  invited: 4,
  pending: 4,
  accepted: 3,
  live: 2,
  completed: 2,
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
};

manageRouter.get("/campaigns/:slug", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<CampaignRow>(
      `SELECT c.id, c.slug, c.campaign_name, c.campaign_status, c.campaign_goal,
              c.raised, c.supporters_going, c.expected_guests, c.verified_visits,
              c.campaign_start_date, c.campaign_end_date, c.invitation_deadline,
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
         cbl.giveback_percentage,
         cbl.participation_hours,
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
      invitationDeadline: toDateOnlyString(campaign.invitation_deadline),
      methods: methods.map((m) => ({
        id: m.id,
        methodType: m.method_type,
        methodName: m.method_name,
        methodStatus: m.method_status,
      })),
      invitations: uniqueInvitations.map((inv) =>
        mapPartnerInvitation(inv, campaign.slug),
      ),
      virtualDonations: {
        count: Number(donationStats[0]?.count ?? 0),
        total: Number(donationStats[0]?.total ?? 0),
      },
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
         cbl.giveback_percentage,
         cbl.participation_hours,
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
              c.campaign_end_date, n.organization_name,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_invited,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND cbl2.acceptance_status IN ('invited', 'pending')
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_pending,
              (SELECT COUNT(DISTINCT LOWER(b2.contact_email))
               FROM campaign_business_locations cbl2
               JOIN businesses b2 ON b2.id = cbl2.business_id
               WHERE cbl2.campaign_id = c.id
                 AND cbl2.acceptance_status = 'changes_requested'
                 AND LOWER(b2.contact_email) LIKE '%@%') AS partners_changes_requested
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
        partnersInvited: Number(r.partners_invited ?? 0),
        partnersPending: Number(r.partners_pending ?? 0),
        partnersChangesRequested: Number(r.partners_changes_requested ?? 0),
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

    const { rows: rows } = await pool.query<QueryResultRow>(
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

    res.json(
      rows.map((r) => ({
        token: r.token,
        businessName: r.business_name,
        locationName: r.location_name,
        campaignName: r.campaign_name,
        campaignSlug: r.campaign_slug,
        methodName: r.method_name,
        givebackPercentage: Number(r.giveback_percentage),
        sentAt: r.sent_at,
        acceptPath: `/?step=nonprofit-accepts-invite&token=${r.token}`,
      })),
    );
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
         cbl.giveback_percentage,
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
         AND cbl.acceptance_status IN ('invited', 'pending', 'changes_requested')
       ORDER BY
         CASE cbl.acceptance_status WHEN 'changes_requested' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         cbl.updated_at DESC`,
      [nonprofitId],
    );

    const unique = dedupePartnerInvitations(rows as PartnerInviteRow[]);

    res.json(
      unique.map((r) => ({
        id: r.id,
        acceptanceStatus: r.acceptance_status,
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
      `SELECT id, action_type, channel, scheduled_date, title, content, status, completed_at
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
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch success engine actions" });
  }
});

manageRouter.patch("/success-engine/:id", async (req, res) => {
  try {
    const { content, status } = req.body as { content?: string; status?: string };
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

manageRouter.get("/campaigns/:slug/settlement", async (req, res) => {
  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, campaign_name, campaign_status, campaign_start_date, campaign_end_date
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
      businessName: s.business_name ?? "Campaign total",
      locationName: s.location_name ?? "—",
      eligibleSales: Number(s.eligible_sales),
      donationPercentage: Number(s.donation_percentage),
      donationPool: Number(s.donation_pool),
      forkupFee: Number(s.forkup_fee),
      netNonprofitAmount: Number(s.net_nonprofit_amount),
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
       WHERE campaign_id = $1 AND donation_type = 'virtual'`,
      [campaign.id],
    );

    res.json({
      campaign: {
        name: campaign.campaign_name,
        status: campaign.campaign_status,
        startDate: toDateOnlyString(campaign.campaign_start_date),
        endDate: toDateOnlyString(campaign.campaign_end_date),
        isLocked: campaign.campaign_status === "settlement",
      },
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
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch settlement report" });
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

manageRouter.post("/campaigns/:slug/lock", async (req, res) => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id, campaign_status FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaignId = Number(campaigns[0].id);
    if (campaigns[0].campaign_status === "settlement") {
      res.status(400).json({ error: "Campaign is already locked for settlement" });
      return;
    }

    await connection.query(
      `UPDATE campaigns SET campaign_status = 'settlement', updated_at = NOW() WHERE id = $1`,
      [campaignId],
    );

    await connection.query(
      `UPDATE settlements SET locked_at = NOW(), report_generated_at = NOW() WHERE campaign_id = $1`,
      [campaignId],
    );

    await connection.query("COMMIT");
    res.json({ success: true, status: "settlement" });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to lock campaign" });
  } finally {
    connection.release();
  }
});
