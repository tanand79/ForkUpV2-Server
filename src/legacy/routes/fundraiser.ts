/**
 * Fundraiser → nonprofit campaign invitations.
 *
 * Purpose: A fundraiser (not an org member) proposes a draft campaign for a
 * nonprofit. Email + dashboard invite; on accept nonprofit owns the campaign
 * and the fundraiser becomes an active co-organizer (campaign_fundraisers).
 *
 * Routes (mounted at /api/fundraiser):
 * - POST   /invites              auth — create draft + invite + email
 * - GET    /invites/:token       public — invite details
 * - POST   /invites/:token/accept
 * - POST   /invites/:token/decline
 * - GET    /my-invites           auth — fundraiser's sent invites
 */
import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { generateInvitationToken } from "../lib/invitations";
import { promoteFundraiserDraftOnAccept } from "../lib/fundraiser-accept-launch";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import { METHOD_LABELS, METHOD_REQUIRES_BUSINESS } from "../lib/methods";
import {
  evaluateBusinessMethodTiming,
  hasBusinessMethods,
  validateMethodDateRequirements,
} from "../lib/campaign-timing";
import { uniqueCampaignSlug } from "../lib/slug";
import { pool } from "../db/pool";
import type { MethodType } from "../types/campaign";
import { toDateOnlyString } from "../lib/date-only";
import { ensureDurableImageUrl } from "../lib/ensure-durable-image";

export const fundraiserRouter = Router();

const DEFAULT_METHODS: MethodType[] = ["virtual_donations", "ambassador_fundraising"];
const ALL_METHOD_TYPES = new Set<MethodType>(Object.keys(METHOD_LABELS) as MethodType[]);

type CreateInviteBody = {
  nonprofitId?: number;
  campaignName?: string;
  campaignStory?: string;
  campaignGoal?: number;
  startDate?: string | null;
  endDate?: string | null;
  /** Guest Bartending event date (Nick V2 Layer 2). */
  eventDate?: string | null;
  coverImage?: string | null;
  message?: string | null;
  methods?: MethodType[];
  /** Fundraiser submitted short timeline for ForkUp review in the AI dates UI. */
  submitForForkupReview?: boolean;
};

/**
 * Guest Bartending always includes Ambassador Sharing (same as builder).
 */
function withImpliedAmbassador(methods: MethodType[]): MethodType[] {
  if (
    methods.includes("guest_bartending_event") &&
    !methods.includes("ambassador_fundraising")
  ) {
    return [...methods, "ambassador_fundraising"];
  }
  return methods;
}

function normalizeInviteMethods(raw: unknown): MethodType[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_METHODS];
  const parsed = raw.filter(
    (m): m is MethodType => typeof m === "string" && ALL_METHOD_TYPES.has(m as MethodType),
  );
  if (parsed.length === 0) return [...DEFAULT_METHODS];
  return withImpliedAmbassador(parsed);
}

async function userIsNonprofitMember(
  userId: number,
  nonprofitId: number,
): Promise<boolean> {
  const { rows } = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM organization_users
     WHERE organization_type = 'nonprofit'
       AND organization_id = $1
       AND user_id = $2
     LIMIT 1`,
    [nonprofitId, userId],
  );
  return rows.length > 0;
}

/**
 * method: POST /api/fundraiser/invites
 * body: {
 *   nonprofitId, campaignName, campaignStory, campaignGoal?, startDate?, endDate?,
 *   eventDate?, coverImage?, message?, methods?, submitForForkupReview?
 * }
 * response: { token, acceptPath, campaignSlug, campaignName }
 *
 * Changelog: Persists selected methods + event date + ForkUp timing flags so
 * NPO accept cannot go live while short-timeline business methods need review.
 */
fundraiserRouter.post("/invites", async (req, res) => {
  const connection = await pool.connect();
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required to invite a nonprofit" });
      return;
    }

    const body = req.body as CreateInviteBody;
    const nonprofitId = Number(body.nonprofitId);
    const campaignName = body.campaignName?.trim() ?? "";
    const campaignStory = body.campaignStory?.trim() ?? "";

    if (!nonprofitId) {
      res.status(400).json({ error: "nonprofitId is required" });
      return;
    }
    if (!campaignName || !campaignStory) {
      res.status(400).json({ error: "campaignName and campaignStory are required" });
      return;
    }

    if (await userIsNonprofitMember(authUser.id, nonprofitId)) {
      res.status(400).json({
        error:
          "You already belong to this nonprofit. Create the campaign from your nonprofit dashboard instead.",
      });
      return;
    }

    const { rows: npRows } = await connection.query<QueryResultRow>(
      "SELECT id, organization_name, contact_email, contact_name FROM nonprofits WHERE id = $1",
      [nonprofitId],
    );
    if (npRows.length === 0) {
      res.status(404).json({ error: "Nonprofit not found" });
      return;
    }
    const nonprofit = npRows[0];

    const methods = normalizeInviteMethods(body.methods);
    let coverImage =
      (typeof body.coverImage === "string" && body.coverImage.trim()) ||
      "/placeholder-cover.jpg";
    if (coverImage !== "/placeholder-cover.jpg") {
      try {
        coverImage = await ensureDurableImageUrl(coverImage, "covers");
      } catch (mirrorErr) {
        console.warn("Failed to re-host fundraiser cover image:", mirrorErr);
        res.status(400).json({
          error:
            "Could not store the campaign cover image. Upload the file directly or pick another image.",
        });
        return;
      }
    }
    const startDate = toDateOnlyString(body.startDate);
    const endDate = toDateOnlyString(body.endDate);
    const eventDate = toDateOnlyString(body.eventDate);
    const dateError = validateMethodDateRequirements({
      methods,
      startDate,
      endDate,
      eventDate,
    });
    if (dateError) {
      res.status(400).json({ error: dateError });
      return;
    }

    const timingEval = evaluateBusinessMethodTiming({
      methods,
      startDate,
      eventDate,
    });
    if (timingEval.status === "too_soon" && hasBusinessMethods(methods)) {
      res.status(400).json({
        error:
          "This start/event date is too soon for a new business-based campaign (0–7 days). Change the date or continue with Online Donation / Ambassador Sharing only.",
        timing: timingEval,
      });
      return;
    }
    const submitForForkupReview = Boolean(body.submitForForkupReview);
    const wantsForkupReview =
      submitForForkupReview && timingEval.status === "tight_timeline";
    const businessTimingStatus = wantsForkupReview
      ? "needs_forkup_review"
      : timingEval.status;
    const forkupReviewStatus = wantsForkupReview ? "pending" : "none";
    const methodTimingStatus = wantsForkupReview
      ? "needs_forkup_review"
      : timingEval.status;
    const needsForkupReview = wantsForkupReview;

    const fundraiserName = authUser.fullName?.trim() || authUser.email;
    const fundraiserEmail = authUser.email;

    await connection.query("BEGIN");

    const slug = await uniqueCampaignSlug(campaignName, async (s) => {
      const { rows } = await connection.query<QueryResultRow>(
        "SELECT id FROM campaigns WHERE slug = $1",
        [s],
      );
      return rows.length > 0;
    });

    const { rows: campResult } = await connection.query<{ id: number }>(
      `INSERT INTO campaigns (
        slug, nonprofit_id, campaign_name, campaign_story, campaign_goal,
        campaign_start_date, campaign_end_date, event_date, campaign_status, cover_image_url,
        created_by_user_id, business_timing_status, forkup_review_status,
        forkup_review_requested_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12,
        CASE WHEN $13 THEN NOW() ELSE NULL END
      )
       RETURNING id`,
      [
        slug,
        nonprofitId,
        campaignName,
        campaignStory,
        body.campaignGoal ?? 0,
        startDate,
        endDate,
        eventDate,
        coverImage,
        authUser.id,
        businessTimingStatus,
        forkupReviewStatus,
        needsForkupReview,
      ],
    );
    const campaignId = campResult[0].id;

    for (const methodType of methods) {
      await connection.query(
        `INSERT INTO campaign_methods (
          campaign_id, method_type, method_name, method_status,
          requires_business_acceptance, timing_status
        ) VALUES ($1, $2, $3, 'draft', $4, $5)`,
        [
          campaignId,
          methodType,
          METHOD_LABELS[methodType] ?? methodType,
          METHOD_REQUIRES_BUSINESS[methodType],
          METHOD_REQUIRES_BUSINESS[methodType] ? methodTimingStatus : "ok",
        ],
      );
    }

    await connection.query(
      `INSERT INTO campaign_fundraisers (campaign_id, user_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (campaign_id, user_id) DO UPDATE SET status = 'pending'`,
      [campaignId, authUser.id],
    );

    const token = generateInvitationToken();
    await connection.query(
      `INSERT INTO fundraiser_campaign_invitations (
        token, fundraiser_user_id, fundraiser_name, fundraiser_email,
        nonprofit_id, campaign_id, message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        token,
        authUser.id,
        fundraiserName,
        fundraiserEmail,
        nonprofitId,
        campaignId,
        body.message?.trim() || null,
      ],
    );

    await connection.query("COMMIT");

    const acceptPath = `/?step=fundraiser-invite-accept&token=${token}`;
    const nonprofitEmail =
      typeof nonprofit.contact_email === "string"
        ? nonprofit.contact_email.trim()
        : "";
    if (nonprofitEmail) {
      const acceptUrl = `${resolveFrontendBaseUrl()}${acceptPath}`;
      await sendEmail({
        to: nonprofitEmail,
        name:
          typeof nonprofit.contact_name === "string"
            ? nonprofit.contact_name
            : null,
        subject: `${fundraiserName} proposed a ForkUp campaign for ${nonprofit.organization_name}`,
        body:
          `Hi ${nonprofit.organization_name},\n\n` +
          `${fundraiserName} (${fundraiserEmail}) wants to run a campaign with you on ForkUp:\n` +
          `"${campaignName}"\n\n` +
          (body.message?.trim()
            ? `Message from ${fundraiserName}:\n${body.message.trim()}\n\n`
            : "") +
          `Review and respond here:\n${acceptUrl}\n\n` +
          `— ForkUp`,
        emailType: "fundraiser_campaign_invitation",
        campaignId,
        stakeholderRole: "nonprofit",
        relatedToken: token,
        platformSender: true,
        fromName: fundraiserName,
        replyTo: fundraiserEmail.includes("@") ? fundraiserEmail : null,
      });
    }

    res.status(201).json({
      token,
      acceptPath,
      campaignSlug: slug,
      campaignName,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to send fundraiser invitation" });
  } finally {
    connection.release();
  }
});

/**
 * method: GET /api/fundraiser/invites/:token
 * response: invite + nonprofit + campaign summary
 */
fundraiserRouter.get("/invites/:token", async (req, res) => {
  try {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT
         fci.*,
         n.organization_name, n.contact_email AS nonprofit_email,
         c.slug AS campaign_slug, c.campaign_name, c.campaign_story,
         c.campaign_start_date, c.campaign_end_date, c.campaign_status,
         c.campaign_goal, c.cover_image_url
       FROM fundraiser_campaign_invitations fci
       JOIN nonprofits n ON n.id = fci.nonprofit_id
       JOIN campaigns c ON c.id = fci.campaign_id
       WHERE fci.token = $1`,
      [req.params.token],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const row = rows[0];
    res.json({
      token: row.token,
      invitationStatus: row.invitation_status,
      message: row.message,
      fundraiser: {
        name: row.fundraiser_name,
        email: row.fundraiser_email,
      },
      nonprofit: {
        id: Number(row.nonprofit_id),
        name: row.organization_name,
        email: row.nonprofit_email,
      },
      campaign: {
        slug: row.campaign_slug,
        name: row.campaign_name,
        story: row.campaign_story,
        goal: Number(row.campaign_goal ?? 0),
        startDate: row.campaign_start_date,
        endDate: row.campaign_end_date,
        status: row.campaign_status,
        coverImageUrl: row.cover_image_url,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invitation" });
  }
});

/**
 * method: POST /api/fundraiser/invites/:token/accept
 * response: { success, invitationStatus, campaignSlug, campaignStatus }
 *
 * Additive: after accept, promote draft campaign with the same launch rules as
 * builder (ready_to_launch / live / invitation_phase).
 */
fundraiserRouter.post("/invites/:token/accept", async (req, res) => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows } = await connection.query<QueryResultRow>(
      `SELECT * FROM fundraiser_campaign_invitations WHERE token = $1`,
      [req.params.token],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const invite = rows[0];
    if (invite.invitation_status !== "pending") {
      res.status(400).json({ error: "This invitation has already been responded to" });
      return;
    }

    await connection.query(
      `UPDATE fundraiser_campaign_invitations
       SET invitation_status = 'accepted', responded_at = NOW()
       WHERE id = $1`,
      [invite.id],
    );

    await connection.query(
      `UPDATE campaign_fundraisers
       SET status = 'active'
       WHERE campaign_id = $1 AND user_id = $2`,
      [invite.campaign_id, invite.fundraiser_user_id],
    );

    const { rows: campaign } = await connection.query<QueryResultRow>(
      `SELECT slug, campaign_status, campaign_start_date
       FROM campaigns WHERE id = $1`,
      [invite.campaign_id],
    );

    const campaignStatus = await promoteFundraiserDraftOnAccept(
      connection,
      Number(invite.campaign_id),
      campaign[0]?.campaign_start_date ?? null,
    );

    await connection.query("COMMIT");
    res.json({
      success: true,
      invitationStatus: "accepted",
      campaignSlug: campaign[0]?.slug,
      campaignStatus,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to accept invitation" });
  } finally {
    connection.release();
  }
});

/**
 * method: POST /api/fundraiser/invites/:token/decline
 * body: { reason? }
 * response: { success, invitationStatus }
 */
fundraiserRouter.post("/invites/:token/decline", async (req, res) => {
  const connection = await pool.connect();
  try {
    const reason =
      typeof (req.body as { reason?: string })?.reason === "string"
        ? (req.body as { reason?: string }).reason?.trim()
        : null;

    await connection.query("BEGIN");

    const { rows } = await connection.query<QueryResultRow>(
      `SELECT * FROM fundraiser_campaign_invitations WHERE token = $1`,
      [req.params.token],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const invite = rows[0];
    if (invite.invitation_status !== "pending") {
      res.status(400).json({ error: "This invitation has already been responded to" });
      return;
    }

    await connection.query(
      `UPDATE fundraiser_campaign_invitations
       SET invitation_status = 'declined',
           responded_at = NOW(),
           message = COALESCE($1, message)
       WHERE id = $2`,
      [reason || null, invite.id],
    );

    await connection.query(
      `UPDATE campaign_fundraisers
       SET status = 'removed'
       WHERE campaign_id = $1 AND user_id = $2`,
      [invite.campaign_id, invite.fundraiser_user_id],
    );

    await connection.query(
      `UPDATE campaigns SET campaign_status = 'closed', updated_at = NOW()
       WHERE id = $1 AND campaign_status = 'draft'`,
      [invite.campaign_id],
    );

    await connection.query("COMMIT");
    res.json({ success: true, invitationStatus: "declined" });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to decline invitation" });
  } finally {
    connection.release();
  }
});

/**
 * method: GET /api/fundraiser/my-invites
 * response: array of invites sent by the authenticated fundraiser
 */
fundraiserRouter.get("/my-invites", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT
         fci.token, fci.invitation_status, fci.sent_at, fci.responded_at, fci.message,
         n.organization_name,
         c.slug AS campaign_slug, c.campaign_name, c.campaign_status
       FROM fundraiser_campaign_invitations fci
       JOIN nonprofits n ON n.id = fci.nonprofit_id
       JOIN campaigns c ON c.id = fci.campaign_id
       WHERE fci.fundraiser_user_id = $1
       ORDER BY fci.sent_at DESC`,
      [authUser.id],
    );

    res.json(
      rows.map((r) => ({
        token: r.token,
        invitationStatus: r.invitation_status,
        sentAt: r.sent_at,
        respondedAt: r.responded_at,
        message: r.message,
        nonprofitName: r.organization_name,
        campaignSlug: r.campaign_slug,
        campaignName: r.campaign_name,
        campaignStatus: r.campaign_status,
        acceptPath: `/?step=fundraiser-invite-accept&token=${r.token}`,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch fundraiser invitations" });
  }
});
