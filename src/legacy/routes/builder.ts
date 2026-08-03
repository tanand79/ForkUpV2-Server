import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { ensureInvitationToken, maybePromoteCampaignToLive } from "../lib/invitations";
import { uniqueCampaignSlug } from "../lib/slug";
import {
  METHOD_CAPABILITY,
  METHOD_LABELS,
  METHOD_REQUIRES_BUSINESS,
  requiresAnyBusiness,
} from "../lib/methods";
import { addCalendarDays, subtractCalendarDays, toDateOnlyString } from "../lib/date-only";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { resolveStoredImageUrl } from "../lib/s3";
import {
  fetchApprovedLibraryItems,
  pickLaunchSnippet,
  pickImpactSnippet,
} from "../lib/organization-library";
import {
  evaluateBusinessMethodTiming,
  hasBusinessMethods,
  validateMethodDateRequirements,
  type MethodTimingEvaluation,
  type TimingStatus,
} from "../lib/campaign-timing";
import { computeRespondByDate } from "../lib/business-invite-timing";
import { insertBusinessInvitationRecord } from "../lib/business-invitation-record";
import { sendInitialInvitationEmails } from "../lib/business-lifecycle-emails";
import { pool } from "../db/pool";
import type { MethodType } from "../types/campaign";

type InviteEmailRow = QueryResultRow & {
  token: string;
  business_name: string;
  location_name: string;
  acceptance_status: string;
  contact_email: string | null;
};

/**
 * Emails each newly invited business its acceptance link (Nick V2 Layer 5 Email 1).
 * Idempotent per invitation token (onlyOnce). Failures are swallowed by the mailer.
 */
async function sendBusinessInviteEmails(campaignId: number): Promise<void> {
  await sendInitialInvitationEmails(campaignId);
}

export const builderRouter = Router();

type BusinessRow = QueryResultRow & {
  id: number;
  business_name: string;
  business_type: string;
  default_giveback_percentage: number;
  supports_dine_and_donate: boolean;
  supports_shop_and_donate: boolean;
  supports_service_giveback: boolean;
  supports_guest_bartending: boolean;
  location_id: number;
  location_name: string;
  city: string;
  state: string;
};

type CreateCampaignBody = {
  nonprofit: {
    organizationName: string;
    contactName: string;
    contactEmail: string;
    mission?: string;
    causeCategory?: string;
  };
  campaignName: string;
  campaignStory: string;
  campaignGoal: number;
  startDate?: string;
  endDate?: string;
  /** Guest Bartending single event date (Nick V2 Layer 2). */
  eventDate?: string;
  coverImage: string;
  methods: MethodType[];
  invitations?: {
    businessId: number;
    locationId: number;
    methodType: MethodType;
    givebackPercentage?: number;
    businessEmail?: string;
    messageToBusiness?: string;
    proposedTerms?: string;
  }[];
  newBusinessInvites?: {
    businessName: string;
    businessEmail: string;
    methodType: MethodType;
    messageToBusiness?: string;
    proposedTerms?: string;
  }[];
  termsAccepted: boolean;
  launch?: boolean;
  existingSlug?: string;
  /** Nonprofit chose CTA: submit short business timeline for ForkUp review. */
  submitForForkupReview?: boolean;
  /** Nonprofit chose CTA: drop business methods and continue online/ambassador only. */
  continueWithoutBusinessMethods?: boolean;
};

/**
 * Resolves methods after Guest Bartending→Ambassador implication and optional
 * "continue without business methods" CTA (Nick V2 Layer 2).
 */
function resolveMethodsForSave(body: CreateCampaignBody): MethodType[] {
  let methods = withImpliedAmbassador(body.methods ?? []);
  if (body.continueWithoutBusinessMethods) {
    methods = methods.filter((m) => !METHOD_REQUIRES_BUSINESS[m]);
  }
  return methods;
}

/** Effective start date: explicit, else today when launching online/ambassador-only. */
function resolveStartDate(body: CreateCampaignBody, methods: MethodType[]): string | null {
  const explicit = toDateOnlyString(body.startDate);
  if (explicit) return explicit;
  if (body.launch && !hasBusinessMethods(methods)) {
    return toDateOnlyString(new Date());
  }
  return null;
}

function timingFieldsFromEvaluation(
  evaluation: MethodTimingEvaluation,
  body: CreateCampaignBody,
): {
  businessTimingStatus: TimingStatus;
  forkupReviewStatus: string;
  forkupReviewReason: string | null;
  forkupReviewRequestedAt: Date | null;
} {
  const businessTimingStatus = evaluation.status;
  // Option 2: only short-timeline business methods enter ForkUp review on launch.
  const needsReview =
    evaluation.status === "needs_forkup_review" &&
    (Boolean(body.launch) || Boolean(body.submitForForkupReview));
  if (needsReview) {
    return {
      businessTimingStatus,
      forkupReviewStatus: "pending",
      forkupReviewReason:
        evaluation.message ||
        "Campaign submitted for ForkUp review (short business-method timeline).",
      forkupReviewRequestedAt: new Date(),
    };
  }
  return {
    businessTimingStatus,
    forkupReviewStatus: "none",
    forkupReviewReason: null,
    forkupReviewRequestedAt: null,
  };
}

/** True when Launch must wait for superadmin (short timeline), not go live. */
function launchRequiresForkupReview(timingFields: {
  forkupReviewStatus: string;
}): boolean {
  return timingFields.forkupReviewStatus === "pending";
}

function formatDate(value: string | Date | null | undefined): string | null {
  return toDateOnlyString(value);
}

type SuccessDraftAction = {
  action_type: string;
  title: string;
  content: string;
  scheduled_date: string;
};

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
 * Extra reminders that ship pre-flagged for automated sending. These are appended
 * alongside (never replacing) the existing launch/one-week/final-push actions.
 */
function buildAutomatedReminders(
  startDate: string,
  endDate: string,
  impactSnippet: string | null,
): SuccessDraftAction[] {
  const start = toDateOnlyString(startDate);
  const end = toDateOnlyString(endDate);
  if (!start || !end) return [];
  return [
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
}

async function insertSuccessEngineDraft(
  connection: PoolClient,
  campaignId: number,
  campaignName: string,
  startDate: string,
  endDate: string,
  nonprofitId?: number,
) {
  const { rows: existing } = await connection.query<QueryResultRow>(
    "SELECT id FROM success_engine_actions WHERE campaign_id = $1 LIMIT 1",
    [campaignId],
  );
  if (existing.length > 0) return;

  const approvedItems = nonprofitId
    ? await fetchApprovedLibraryItems("nonprofit", nonprofitId)
    : [];
  const snippet = nonprofitId ? pickLaunchSnippet(approvedItems) : null;
  const impactSnippet = nonprofitId ? pickImpactSnippet(approvedItems) : null;
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
  for (const action of buildAutomatedReminders(startDate, endDate, impactSnippet)) {
    await connection.query(
      `INSERT INTO success_engine_actions (campaign_id, action_type, channel, scheduled_date, title, content, status, auto_send)
       VALUES ($1, $2, 'email', $3, $4, $5, 'ready', TRUE)`,
      [campaignId, action.action_type, action.scheduled_date, action.title, action.content],
    );
  }
}

type LaunchStatus = "invitation_phase" | "ready_to_launch" | "live";

function isStartDateReached(startDate: string): boolean {
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start.getTime() <= today.getTime();
}

/**
 * Guest Bartending always includes Ambassador Sharing (Nick V2 Layer 1).
 * Inputs: selected method types from the builder payload.
 * Outputs: same list with ambassador_fundraising appended when needed.
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

/**
 * Resolves campaign launch status without letting pending business invites
 * block the default fundraising layer (online donations + ambassador).
 * Business-only campaigns still wait in invitation_phase until a partner accepts.
 * Inputs: DB connection, campaign id, optional start date, optional selected methods.
 * Outputs: invitation_phase | ready_to_launch | live.
 */
async function resolveLaunchStatus(
  connection: PoolClient,
  campaignId: number,
  startDate?: string,
  selectedMethods?: MethodType[],
): Promise<LaunchStatus> {
  let hasDefaultFundraisingLayer = false;

  if (selectedMethods && selectedMethods.length > 0) {
    hasDefaultFundraisingLayer = selectedMethods.some(
      (m) => !METHOD_REQUIRES_BUSINESS[m],
    );
  } else {
    const { rows: methods } = await connection.query<QueryResultRow>(
      `SELECT requires_business_acceptance
       FROM campaign_methods WHERE campaign_id = $1`,
      [campaignId],
    );
    hasDefaultFundraisingLayer = methods.some(
      (m) => !Boolean(m.requires_business_acceptance),
    );
  }

  // Pending business invites block ONLY business-only campaigns.
  // Online donations / ambassador can proceed to ready_to_launch / live.
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

  if (startDate && isStartDateReached(startDate)) return "live";
  return "ready_to_launch";
}

function businessSupportsMethod(row: BusinessRow, methodType: MethodType): boolean {
  const cap = METHOD_CAPABILITY[methodType];
  return Boolean(row[cap as keyof BusinessRow]);
}

type NewBusinessInviteInput = {
  businessName: string;
  businessEmail: string;
  methodType: MethodType;
  messageToBusiness?: string;
  proposedTerms?: string;
};

/** Reuse an existing business by email; skip duplicates already on the campaign. */
async function upsertNewBusinessInvite(
  connection: PoolClient,
  params: {
    campaignId: number;
    nonprofitId: number;
    methodId: number;
    invite: NewBusinessInviteInput;
    existingPartnerKeys: Set<string>;
    existingPartnerEmails: Set<string>;
    startOrEventDate?: string | null;
    invitedByUserId?: number | null;
  },
): Promise<boolean> {
  const {
    campaignId,
    nonprofitId,
    methodId,
    invite,
    existingPartnerKeys,
    existingPartnerEmails,
    startOrEventDate,
    invitedByUserId,
  } = params;
  const email = invite.businessEmail.trim().toLowerCase();
  const name = invite.businessName.trim();
  if (!email.includes("@") || !name) return false;

  if (existingPartnerEmails.has(email)) return false;

  const { rows: existingCbl } = await connection.query<QueryResultRow>(
    `SELECT cbl.id
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     WHERE cbl.campaign_id = $1 AND LOWER(b.contact_email) = $2
     LIMIT 1`,
    [campaignId, email],
  );
  if (existingCbl.length > 0) {
    existingPartnerEmails.add(email);
    return false;
  }

  let businessId: number;
  let locationId: number;

  const { rows: existingBiz } = await connection.query<QueryResultRow>(
    `SELECT b.id AS business_id, bl.id AS location_id
     FROM businesses b
     LEFT JOIN business_locations bl ON bl.business_id = b.id AND bl.active_status = TRUE
     WHERE LOWER(b.contact_email) = $1
     ORDER BY bl.id ASC
     LIMIT 1`,
    [email],
  );

  if (existingBiz.length > 0) {
    businessId = Number(existingBiz[0].business_id);
    locationId = Number(existingBiz[0].location_id);
    if (!locationId) {
      const { rows: locResult } = await connection.query<{ id: number }>(
        `INSERT INTO business_locations (business_id, location_name, city, state)
         VALUES ($1, 'Main Location', 'TBD', 'TBD') RETURNING id`,
        [businessId],
      );
      locationId = locResult[0].id;
    }
  } else {
    const newBizSlug = name
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .slice(0, 200);

    const { rows: bizResult } = await connection.query<{ id: number }>(
      `INSERT INTO businesses (
          business_name, slug, contact_email, business_status, claim_status,
          supports_dine_and_donate, supports_shop_and_donate,
          supports_service_giveback, supports_guest_bartending
        ) VALUES ($1, $2, $3, 'invited', 'unclaimed', $4, $5, $6, $7) RETURNING id`,
      [
        name,
        `${newBizSlug}-${Date.now()}`,
        email,
        invite.methodType === "dine_and_donate",
        invite.methodType === "shop_and_donate",
        invite.methodType === "service_giveback",
        invite.methodType === "guest_bartending_event",
      ],
    );
    businessId = bizResult[0].id;

    const { rows: locResult } = await connection.query<{ id: number }>(
      `INSERT INTO business_locations (business_id, location_name, city, state)
       VALUES ($1, 'Main Location', 'TBD', 'TBD') RETURNING id`,
      [businessId],
    );
    locationId = locResult[0].id;
  }

  const partnerKey = `${businessId}:${locationId}`;
  if (existingPartnerKeys.has(partnerKey)) {
    existingPartnerEmails.add(email);
    return false;
  }

  const respondByDate = computeRespondByDate({
    sentDate: new Date(),
    startOrEventDate,
  });

  const givebackPercentage = 10;
  const messageToBusiness = invite.messageToBusiness?.trim() || null;
  const proposedTerms = invite.proposedTerms?.trim() || null;

  const { rows: cblResult } = await connection.query<{ id: number }>(
    `INSERT INTO campaign_business_locations (
      campaign_id, method_id, business_id, location_id,
      invite_status, acceptance_status, giveback_percentage,
      respond_by_date, invited_by_user_id, setup_status,
      message_to_business, proposed_terms
    ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
     RETURNING id`,
    [
      campaignId,
      methodId,
      businessId,
      locationId,
      givebackPercentage,
      respondByDate,
      invitedByUserId ?? null,
      messageToBusiness,
      proposedTerms,
    ],
  );
  await ensureInvitationToken(connection, cblResult[0].id);

  await insertBusinessInvitationRecord(connection, {
    campaignId,
    nonprofitId,
    methodId,
    businessId,
    businessName: name,
    businessEmail: email,
    campaignBusinessLocationId: cblResult[0].id,
    respondByDate,
    invitedByUserId,
    proposedGivebackPercentage: givebackPercentage,
    messageToBusiness,
    proposedTerms,
  });

  existingPartnerKeys.add(partnerKey);
  existingPartnerEmails.add(email);
  return true;
}

async function linkUserToNonprofit(
  connection: PoolClient,
  userId: number,
  nonprofitId: number,
) {
  await connection.query(
    `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
     VALUES ('nonprofit', $1, $2, 'admin')
     ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
    [nonprofitId, userId],
  );
}

builderRouter.get("/businesses", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params: string[] = [];
    let where = "WHERE bl.active_status = TRUE";
    if (q) {
      where += " AND (b.business_name ILIKE $1 OR bl.city ILIKE $2 OR bl.location_name ILIKE $3)";
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const { rows: rows } = await pool.query<BusinessRow>(
      `SELECT
         b.id,
         b.business_name,
         b.business_type,
         b.default_giveback_percentage,
         b.supports_dine_and_donate,
         b.supports_shop_and_donate,
         b.supports_service_giveback,
         b.supports_guest_bartending,
         bl.id AS location_id,
         bl.location_name,
         bl.city,
         bl.state
       FROM businesses b
       JOIN business_locations bl ON bl.business_id = b.id
       ${where}
       ORDER BY b.business_name, bl.location_name`,
      params,
    );

    const grouped = new Map<
      number,
      {
        id: number;
        businessName: string;
        businessType: string;
        defaultGivebackPercentage: number;
        capabilities: MethodType[];
        locations: { id: number; locationName: string; city: string; state: string }[];
      }
    >();

    for (const row of rows) {
      const capabilities = (Object.keys(METHOD_CAPABILITY) as MethodType[]).filter((m) =>
        businessSupportsMethod(row, m),
      );

      if (!grouped.has(row.id)) {
        grouped.set(row.id, {
          id: row.id,
          businessName: row.business_name,
          businessType: row.business_type ?? "Business",
          defaultGivebackPercentage: Number(row.default_giveback_percentage ?? 10),
          capabilities,
          locations: [],
        });
      }

      grouped.get(row.id)!.locations.push({
        id: row.location_id,
        locationName: row.location_name,
        city: row.city ?? "",
        state: row.state ?? "",
      });
    }

    res.json([...grouped.values()]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

builderRouter.get("/campaigns/:slug", async (req, res) => {
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT c.id, c.slug, c.nonprofit_id, c.campaign_name, c.campaign_story, c.campaign_goal,
              c.campaign_start_date, c.campaign_end_date, c.cover_image_url, c.campaign_status
       FROM campaigns c WHERE c.slug = $1`,
      [slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaign = campaigns[0];

    const { rows: methods } = await pool.query<QueryResultRow>(
      `SELECT method_type FROM campaign_methods WHERE campaign_id = $1 ORDER BY id`,
      [campaign.id],
    );

    const { rows: partners } = await pool.query<QueryResultRow>(
      `SELECT
         cbl.business_id, cbl.location_id, cbl.giveback_percentage, cbl.acceptance_status,
         b.business_name, b.contact_email AS business_email,
         bl.location_name, bl.city, bl.state,
         cm.method_type
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1
       ORDER BY b.business_name, bl.location_name`,
      [campaign.id],
    );

    const { rows: originRows } = await pool.query<QueryResultRow>(
      `SELECT id FROM nonprofit_campaign_invitations
       WHERE campaign_id = $1 AND invitation_status = 'accepted' LIMIT 1`,
      [campaign.id],
    );

    res.json({
      slug: campaign.slug,
      /** Additive: needed so guest→signup can link the campaign's nonprofit. */
      nonprofitId: Number(campaign.nonprofit_id),
      campaignName: campaign.campaign_name,
      campaignStory: campaign.campaign_story,
      campaignGoal: Number(campaign.campaign_goal ?? 0),
      startDate: formatDate(campaign.campaign_start_date),
      endDate: formatDate(campaign.campaign_end_date),
      coverImageUrl: await resolveStoredImageUrl(campaign.cover_image_url),
      status: campaign.campaign_status,
      origin: originRows.length > 0 ? "business_invite" : "nonprofit",
      methods: methods.map((m) => m.method_type),
      partners: partners.map((p) => ({
        businessId: p.business_id,
        locationId: p.location_id,
        businessName: p.business_name,
        businessEmail: p.business_email,
        locationName: p.location_name,
        city: p.city,
        state: p.state,
        methodType: p.method_type,
        givebackPercentage: Number(p.giveback_percentage),
        acceptanceStatus: p.acceptance_status,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

builderRouter.patch("/campaigns/:slug", async (req, res) => {
  const connection = await pool.connect();
  try {
    const body = req.body as CreateCampaignBody;
    const slug = req.params.slug.replace(/\/+$/, "");

    if (!body.campaignName?.trim()) {
      res.status(400).json({ error: "Campaign name is required" });
      return;
    }
    if (!body.campaignStory?.trim()) {
      res.status(400).json({ error: "Campaign story is required" });
      return;
    }
    if (!Array.isArray(body.methods) || body.methods.length === 0) {
      res.status(400).json({ error: "Select at least one fundraising method" });
      return;
    }
    const methodsForSave = resolveMethodsForSave(body);
    if (methodsForSave.length === 0) {
      res.status(400).json({ error: "Select at least one fundraising method" });
      return;
    }
    const dateError = validateMethodDateRequirements({
      methods: methodsForSave,
      startDate: body.startDate,
      endDate: body.endDate,
      eventDate: body.eventDate,
    });
    if (dateError) {
      res.status(400).json({ error: dateError });
      return;
    }
    if (!body.coverImage?.trim()) {
      res.status(400).json({ error: "Campaign cover image is required" });
      return;
    }
    if (
      body.coverImage.startsWith("blob:") ||
      body.coverImage.startsWith("data:")
    ) {
      res.status(400).json({
        error:
          "Campaign cover image must be uploaded to storage before saving. Re-upload the featured image and try again.",
      });
      return;
    }
    if (body.launch && !body.termsAccepted) {
      res.status(400).json({ error: "Terms must be accepted before launch" });
      return;
    }

    const timingEval = evaluateBusinessMethodTiming({
      methods: methodsForSave,
      startDate: body.startDate,
      eventDate: body.eventDate,
    });
    const timingFields = timingFieldsFromEvaluation(timingEval, body);

    await connection.query("BEGIN");

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id, campaign_status, nonprofit_id FROM campaigns WHERE slug = $1",
      [slug],
    );
    if (campaigns.length === 0) {
      await connection.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);
    const nonprofitId = Number(campaigns[0].nonprofit_id);
    const currentStatus = campaigns[0].campaign_status;

    const authUser = await resolveAuthUser(bearerToken(req));
    if (authUser) await linkUserToNonprofit(connection, authUser.id, nonprofitId);

    if (
      !["draft", "ready_to_launch", "in_review"].includes(currentStatus) &&
      !body.launch
    ) {
      res.status(400).json({ error: "This campaign can no longer be edited" });
      return;
    }

    const needsBusiness = requiresAnyBusiness(methodsForSave);
    const resolvedStartDate = resolveStartDate(body, methodsForSave);
    const resolvedEndDate = toDateOnlyString(body.endDate);
    const resolvedEventDate = toDateOnlyString(body.eventDate);
    const { rows: existingPartners } = await connection.query<QueryResultRow>(
      `SELECT cbl.business_id, cbl.location_id, LOWER(b.contact_email) AS contact_email
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       WHERE cbl.campaign_id = $1`,
      [campaignId],
    );
    const existingPartnerKeys = new Set(
      existingPartners.map((p) => `${p.business_id}:${p.location_id}`),
    );
    const existingPartnerEmails = new Set(
      existingPartners
        .map((p) => (p.contact_email ? String(p.contact_email) : ""))
        .filter(Boolean),
    );
    const newInvitationCount =
      (body.invitations?.filter(
        (inv) => !existingPartnerKeys.has(`${inv.businessId}:${inv.locationId}`),
      ).length ?? 0) + (body.newBusinessInvites?.length ?? 0);

    // When timeline needs ForkUp review, business invites are deferred — do not require them.
    const canInviteBusinessesEarly = timingFields.businessTimingStatus === "ok";
    if (
      needsBusiness &&
      body.launch &&
      canInviteBusinessesEarly &&
      existingPartners.length === 0 &&
      newInvitationCount === 0
    ) {
      res.status(400).json({
        error: "At least one business location must be invited for the selected methods",
      });
      return;
    }

    const deadlineAnchor =
      resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
    const invitationDeadline = deadlineAnchor
      ? subtractCalendarDays(deadlineAnchor, 7)
      : null;
    const submitLaunchForReview =
      Boolean(body.launch) && launchRequiresForkupReview(timingFields);
    // Option 2: short timeline → in_review; otherwise resolve normal launch status.
    let nextStatus: LaunchStatus | "draft" | "in_review" = body.launch
      ? submitLaunchForReview
        ? "in_review"
        : await resolveLaunchStatus(
            connection,
            campaignId,
            resolvedStartDate ?? undefined,
            methodsForSave,
          )
      : currentStatus === "ready_to_launch"
        ? "ready_to_launch"
        : currentStatus === "in_review"
          ? "in_review"
          : "draft";

    await connection.query(
      `UPDATE campaigns SET
        campaign_name = $1,
        campaign_story = $2,
        campaign_goal = $3,
        campaign_start_date = $4,
        campaign_end_date = $5,
        event_date = $6,
        cover_image_url = $7,
        invitation_deadline = $8,
        campaign_status = $9,
        terms_accepted = $10,
        terms_accepted_at = CASE WHEN $11 THEN NOW() ELSE terms_accepted_at END,
        business_timing_status = $12,
        forkup_review_status = CASE
          WHEN $13 = 'pending' THEN 'pending'
          WHEN forkup_review_status = 'approved' THEN 'approved'
          ELSE $13
        END,
        forkup_review_reason = COALESCE($14, forkup_review_reason),
        forkup_review_requested_at = CASE
          WHEN $13 = 'pending' THEN COALESCE(forkup_review_requested_at, NOW())
          ELSE forkup_review_requested_at
        END,
        updated_at = NOW()
       WHERE id = $15`,
      [
        body.campaignName.trim(),
        body.campaignStory.trim(),
        body.campaignGoal ?? 0,
        resolvedStartDate,
        resolvedEndDate,
        resolvedEventDate,
        body.coverImage,
        invitationDeadline,
        nextStatus,
        body.termsAccepted,
        body.termsAccepted,
        timingFields.businessTimingStatus,
        timingFields.forkupReviewStatus,
        timingFields.forkupReviewReason,
        campaignId,
      ],
    );

    const { rows: existingMethods } = await connection.query<QueryResultRow>(
      "SELECT id, method_type FROM campaign_methods WHERE campaign_id = $1",
      [campaignId],
    );
    const methodIdByType = new Map<MethodType, number>(
      existingMethods.map((m) => [m.method_type as MethodType, Number(m.id)]),
    );

    for (const methodType of methodsForSave) {
      if (methodIdByType.has(methodType)) {
        await connection.query(
          `UPDATE campaign_methods SET timing_status = $1, updated_at = NOW() WHERE id = $2`,
          [
            METHOD_REQUIRES_BUSINESS[methodType]
              ? timingFields.businessTimingStatus
              : "ok",
            methodIdByType.get(methodType),
          ],
        );
        continue;
      }
      const { rows: methodResult } = await connection.query<{ id: number }>(
        `INSERT INTO campaign_methods (
          campaign_id, method_type, method_name, method_status,
          requires_business_acceptance, timing_status
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          campaignId,
          methodType,
          METHOD_LABELS[methodType],
          body.launch ? "invited" : "draft",
          METHOD_REQUIRES_BUSINESS[methodType],
          METHOD_REQUIRES_BUSINESS[methodType]
            ? timingFields.businessTimingStatus
            : "ok",
        ],
      );
      methodIdByType.set(methodType, methodResult[0].id);
    }

    // Short timelines cannot invite businesses until ForkUp approves (Nick V2 Layer 2).
    const canInviteBusinesses = timingFields.businessTimingStatus === "ok";
    const inviteAnchorDate =
      resolvedEventDate || resolvedStartDate || resolvedEndDate;
    const invitedByUserId = authUser?.id ?? null;

    if (canInviteBusinesses) {
      for (const invite of body.invitations ?? []) {
        const key = `${invite.businessId}:${invite.locationId}`;
        if (existingPartnerKeys.has(key)) continue;

        const methodId = methodIdByType.get(invite.methodType);
        if (!methodId) continue;

        const { rows: bizRows } = await connection.query<BusinessRow>(
          `SELECT b.*, bl.id AS location_id
           FROM businesses b
           JOIN business_locations bl ON bl.business_id = b.id
           WHERE b.id = $1 AND bl.id = $2`,
          [invite.businessId, invite.locationId],
        );
        if (bizRows.length === 0) continue;

        const biz = bizRows[0];
        if (!businessSupportsMethod(biz, invite.methodType)) continue;

        const respondByDate = computeRespondByDate({
          sentDate: new Date(),
          startOrEventDate: inviteAnchorDate,
        });

        const givebackPercentage =
          invite.givebackPercentage ?? biz.default_giveback_percentage ?? 10;
        const messageToBusiness = invite.messageToBusiness?.trim() || null;
        const proposedTerms = invite.proposedTerms?.trim() || null;
        const businessEmail =
          (invite.businessEmail?.trim() ||
            (biz.contact_email ? String(biz.contact_email).trim() : "") ||
            "").toLowerCase() || "unknown@invite.local";

        const { rows: cblResult } = await connection.query<{ id: number }>(
          `INSERT INTO campaign_business_locations (
            campaign_id, method_id, business_id, location_id,
            invite_status, acceptance_status, giveback_percentage,
            respond_by_date, invited_by_user_id, setup_status,
            message_to_business, proposed_terms
          ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
           RETURNING id`,
          [
            campaignId,
            methodId,
            invite.businessId,
            invite.locationId,
            givebackPercentage,
            respondByDate,
            invitedByUserId,
            messageToBusiness,
            proposedTerms,
          ],
        );
        await ensureInvitationToken(connection, cblResult[0].id);
        await insertBusinessInvitationRecord(connection, {
          campaignId,
          nonprofitId,
          methodId,
          businessId: invite.businessId,
          businessName: String(biz.business_name),
          businessEmail,
          campaignBusinessLocationId: cblResult[0].id,
          respondByDate,
          invitedByUserId,
          proposedGivebackPercentage: Number(givebackPercentage),
          messageToBusiness,
          proposedTerms,
        });
        existingPartnerKeys.add(key);
      }

      for (const invite of body.newBusinessInvites ?? []) {
        const methodId = methodIdByType.get(invite.methodType);
        if (!methodId) continue;
        await upsertNewBusinessInvite(connection, {
          campaignId,
          nonprofitId,
          methodId,
          invite,
          existingPartnerKeys,
          existingPartnerEmails,
          startOrEventDate: inviteAnchorDate,
          invitedByUserId,
        });
      }
    }

    if (body.launch && submitLaunchForReview) {
      // Short timeline: stay in_review until superadmin approves.
      nextStatus = "in_review";
      await connection.query(
        `UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`,
        [nextStatus, campaignId],
      );
    } else if (body.launch) {
      // Normal launch (≥30 day lead or non-business methods): go live / ready path.
      nextStatus = await resolveLaunchStatus(
        connection,
        campaignId,
        resolvedStartDate ?? undefined,
        methodsForSave,
      );
      await connection.query(
        `UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`,
        [nextStatus, campaignId],
      );
      await insertSuccessEngineDraft(
        connection,
        campaignId,
        body.campaignName.trim(),
        resolvedStartDate || resolvedEndDate || "",
        resolvedEndDate || resolvedStartDate || "",
        nonprofitId,
      );
      await maybePromoteCampaignToLive(connection, campaignId);
      const { rows: statusRows } = await connection.query<QueryResultRow>(
        "SELECT campaign_status FROM campaigns WHERE id = $1",
        [campaignId],
      );
      nextStatus = String(
        statusRows[0]?.campaign_status ?? nextStatus,
      ) as LaunchStatus;
    }

    await connection.query("COMMIT");

    const { rows: inviteRows } = await connection.query<InviteEmailRow>(
      `SELECT it.token, b.business_name, bl.location_name, cbl.acceptance_status, b.contact_email
       FROM campaign_business_locations cbl
       JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       WHERE cbl.campaign_id = $1`,
      [campaignId],
    );

    if (body.launch && !submitLaunchForReview && canInviteBusinesses) {
      await sendBusinessInviteEmails(campaignId);
    }

    res.json({
      slug,
      /** Additive: needed so guest→signup can link the campaign's nonprofit. */
      nonprofitId,
      campaignStatus: nextStatus,
      campaignName: body.campaignName,
      businessTimingStatus: timingFields.businessTimingStatus,
      forkupReviewStatus: timingFields.forkupReviewStatus,
      timing: timingEval,
      message: body.launch
        ? submitLaunchForReview
          ? "Campaign submitted for ForkUp review"
          : nextStatus === "invitation_phase"
            ? "Campaign updated and moved to invitation phase"
            : nextStatus === "live"
              ? "Campaign is now live"
              : "Campaign is scheduled and will appear publicly on the start date"
        : "Campaign saved",
      invitationLinks: inviteRows.map((row) => ({
        businessName: row.business_name,
        locationName: row.location_name,
        token: row.token,
        acceptanceStatus: row.acceptance_status,
        acceptPath: `/?step=business-acceptance&token=${row.token}`,
      })),
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update campaign" });
  } finally {
    connection.release();
  }
});

builderRouter.post("/campaigns", async (req, res) => {
  const connection = await pool.connect();
  try {
    const body = req.body as CreateCampaignBody;

    if (!body.nonprofit?.organizationName?.trim()) {
      res.status(400).json({ error: "Organization name is required" });
      return;
    }
    if (!body.nonprofit.contactEmail?.includes("@")) {
      res.status(400).json({ error: "Valid contact email is required" });
      return;
    }
    if (!body.campaignName?.trim()) {
      res.status(400).json({ error: "Campaign name is required" });
      return;
    }
    if (!body.campaignStory?.trim()) {
      res.status(400).json({ error: "Campaign story is required" });
      return;
    }
    if (!Array.isArray(body.methods) || body.methods.length === 0) {
      res.status(400).json({ error: "Select at least one fundraising method" });
      return;
    }
    const methodsForSave = resolveMethodsForSave(body);
    if (methodsForSave.length === 0) {
      res.status(400).json({ error: "Select at least one fundraising method" });
      return;
    }
    const dateError = validateMethodDateRequirements({
      methods: methodsForSave,
      startDate: body.startDate,
      endDate: body.endDate,
      eventDate: body.eventDate,
    });
    if (dateError) {
      res.status(400).json({ error: dateError });
      return;
    }
    if (!body.coverImage?.trim()) {
      res.status(400).json({ error: "Campaign cover image is required" });
      return;
    }
    if (
      body.coverImage.startsWith("blob:") ||
      body.coverImage.startsWith("data:")
    ) {
      res.status(400).json({
        error:
          "Campaign cover image must be uploaded to storage before saving. Re-upload the featured image and try again.",
      });
      return;
    }
    if (body.launch && !body.termsAccepted) {
      res.status(400).json({ error: "Terms must be accepted before launch" });
      return;
    }

    const timingEval = evaluateBusinessMethodTiming({
      methods: methodsForSave,
      startDate: body.startDate,
      eventDate: body.eventDate,
    });
    const timingFields = timingFieldsFromEvaluation(timingEval, body);
    const hasInvitations =
      (body.invitations?.length ?? 0) + (body.newBusinessInvites?.length ?? 0) > 0;

    const needsBusiness = requiresAnyBusiness(methodsForSave);
    const resolvedStartDate = resolveStartDate(body, methodsForSave);
    const resolvedEndDate = toDateOnlyString(body.endDate);
    const resolvedEventDate = toDateOnlyString(body.eventDate);
    const canInviteBusinesses = timingFields.businessTimingStatus === "ok";

    if (needsBusiness && body.launch && !hasInvitations && canInviteBusinesses) {
      res.status(400).json({
        error: "At least one business location must be invited for the selected methods",
      });
      return;
    }

    await connection.query("BEGIN");

    const email = body.nonprofit.contactEmail.trim().toLowerCase();
    const orgSlug = body.nonprofit.organizationName
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "");

    const { rows: existingNp } = await connection.query<QueryResultRow>(
      "SELECT id FROM nonprofits WHERE contact_email = $1 OR slug = $2",
      [email, orgSlug],
    );

    let nonprofitId: number;
    if (existingNp.length > 0) {
      nonprofitId = Number(existingNp[0].id);
      await connection.query(
        `UPDATE nonprofits SET
          organization_name = $1,
          contact_name = $2,
          contact_email = $3,
          mission = COALESCE($4, mission),
          cause_category = COALESCE($5, cause_category),
          claim_status = 'claimed',
          updated_at = NOW()
         WHERE id = $6`,
        [
          body.nonprofit.organizationName.trim(),
          body.nonprofit.contactName?.trim() ?? body.nonprofit.organizationName.trim(),
          email,
          body.nonprofit.mission ?? null,
          body.nonprofit.causeCategory ?? null,
          nonprofitId,
        ],
      );
    } else {
      const { rows: npResult } = await connection.query<{ id: number }>(
        `INSERT INTO nonprofits (
          organization_name, slug, mission, cause_category,
          contact_name, contact_email, verification_status, claim_status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'unclaimed', 'claimed') RETURNING id`,
        [
          body.nonprofit.organizationName.trim(),
          orgSlug,
          body.nonprofit.mission ?? null,
          body.nonprofit.causeCategory ?? null,
          body.nonprofit.contactName?.trim() ?? body.nonprofit.organizationName.trim(),
          email,
        ],
      );
      nonprofitId = npResult[0].id;
    }

    const authUser = await resolveAuthUser(bearerToken(req));
    if (authUser) await linkUserToNonprofit(connection, authUser.id, nonprofitId);

    const slug = await uniqueCampaignSlug(body.campaignName, async (s) => {
      const { rows: rows } = await connection.query<QueryResultRow>(
        "SELECT id FROM campaigns WHERE slug = $1",
        [s],
      );
      return rows.length > 0;
    });

    const submitLaunchForReview =
      Boolean(body.launch) && launchRequiresForkupReview(timingFields);
    let campaignStatus: LaunchStatus | "draft" | "in_review" = body.launch
      ? submitLaunchForReview
        ? "in_review"
        : "draft"
      : "draft";

    const deadlineAnchor =
      resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
    const invitationDeadline = deadlineAnchor
      ? subtractCalendarDays(deadlineAnchor, 7)
      : null;

    const { rows: campResult } = await connection.query<{ id: number }>(
      `INSERT INTO campaigns (
        slug, nonprofit_id, campaign_name, campaign_story, campaign_goal,
        campaign_start_date, campaign_end_date, event_date, campaign_status, cover_image_url,
        invitation_deadline, terms_accepted, terms_accepted_at,
        business_timing_status, forkup_review_status, forkup_review_reason,
        forkup_review_requested_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        slug,
        nonprofitId,
        body.campaignName.trim(),
        body.campaignStory.trim(),
        body.campaignGoal ?? 0,
        resolvedStartDate,
        resolvedEndDate,
        resolvedEventDate,
        campaignStatus,
        body.coverImage,
        invitationDeadline,
        body.termsAccepted,
        body.termsAccepted ? new Date() : null,
        timingFields.businessTimingStatus,
        timingFields.forkupReviewStatus,
        timingFields.forkupReviewReason,
        timingFields.forkupReviewRequestedAt,
      ],
    );
    const campaignId = campResult[0].id;

    const methodIdByType = new Map<MethodType, number>();
    for (const methodType of methodsForSave) {
      const { rows: methodResult } = await connection.query<{ id: number }>(
        `INSERT INTO campaign_methods (
          campaign_id, method_type, method_name, method_status,
          requires_business_acceptance, timing_status
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          campaignId,
          methodType,
          METHOD_LABELS[methodType],
          body.launch ? "invited" : "draft",
          METHOD_REQUIRES_BUSINESS[methodType],
          METHOD_REQUIRES_BUSINESS[methodType]
            ? timingFields.businessTimingStatus
            : "ok",
        ],
      );
      methodIdByType.set(methodType, methodResult[0].id);
    }

    const existingPartnerKeys = new Set<string>();
    const existingPartnerEmails = new Set<string>();

    const inviteAnchorDate =
      resolvedEventDate || resolvedStartDate || resolvedEndDate;
    const invitedByUserId = authUser?.id ?? null;

    if (canInviteBusinesses) {
      for (const invite of body.invitations ?? []) {
        const methodId = methodIdByType.get(invite.methodType);
        if (!methodId) continue;

        const { rows: bizRows } = await connection.query<BusinessRow>(
          `SELECT b.*, bl.id AS location_id
           FROM businesses b
           JOIN business_locations bl ON bl.business_id = b.id
           WHERE b.id = $1 AND bl.id = $2`,
          [invite.businessId, invite.locationId],
        );
        if (bizRows.length === 0) continue;

        const biz = bizRows[0];
        if (!businessSupportsMethod(biz, invite.methodType)) continue;

        const respondByDate = computeRespondByDate({
          sentDate: new Date(),
          startOrEventDate: inviteAnchorDate,
        });

        const givebackPercentage =
          invite.givebackPercentage ?? biz.default_giveback_percentage ?? 10;
        const messageToBusiness = invite.messageToBusiness?.trim() || null;
        const proposedTerms = invite.proposedTerms?.trim() || null;
        const businessEmail =
          (invite.businessEmail?.trim() ||
            (biz.contact_email ? String(biz.contact_email).trim() : "") ||
            "").toLowerCase() || "unknown@invite.local";

        const { rows: cblResult } = await connection.query<{ id: number }>(
          `INSERT INTO campaign_business_locations (
            campaign_id, method_id, business_id, location_id,
            invite_status, acceptance_status, giveback_percentage,
            respond_by_date, invited_by_user_id, setup_status,
            message_to_business, proposed_terms
          ) VALUES ($1, $2, $3, $4, 'invited', 'invited', $5, $6, $7, 'pending', $8, $9)
           RETURNING id`,
          [
            campaignId,
            methodId,
            invite.businessId,
            invite.locationId,
            givebackPercentage,
            respondByDate,
            invitedByUserId,
            messageToBusiness,
            proposedTerms,
          ],
        );
        await ensureInvitationToken(connection, cblResult[0].id);
        await insertBusinessInvitationRecord(connection, {
          campaignId,
          nonprofitId,
          methodId,
          businessId: invite.businessId,
          businessName: String(biz.business_name),
          businessEmail,
          campaignBusinessLocationId: cblResult[0].id,
          respondByDate,
          invitedByUserId,
          proposedGivebackPercentage: Number(givebackPercentage),
          messageToBusiness,
          proposedTerms,
        });
        existingPartnerKeys.add(`${invite.businessId}:${invite.locationId}`);
        if (biz.contact_email) {
          existingPartnerEmails.add(String(biz.contact_email).trim().toLowerCase());
        }
      }

      for (const invite of body.newBusinessInvites ?? []) {
        const methodId = methodIdByType.get(invite.methodType);
        if (!methodId) continue;
        await upsertNewBusinessInvite(connection, {
          campaignId,
          nonprofitId,
          methodId,
          invite,
          existingPartnerKeys,
          existingPartnerEmails,
          startOrEventDate: inviteAnchorDate,
          invitedByUserId,
        });
      }
    }

    if (body.launch && submitLaunchForReview) {
      campaignStatus = "in_review";
      await connection.query(
        `UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`,
        [campaignStatus, campaignId],
      );
    } else if (body.launch) {
      campaignStatus = await resolveLaunchStatus(
        connection,
        campaignId,
        resolvedStartDate ?? undefined,
        methodsForSave,
      );
      await connection.query(
        `UPDATE campaigns SET campaign_status = $1, updated_at = NOW() WHERE id = $2`,
        [campaignStatus, campaignId],
      );
      await maybePromoteCampaignToLive(connection, campaignId);
      const { rows: statusRows } = await connection.query<QueryResultRow>(
        "SELECT campaign_status FROM campaigns WHERE id = $1",
        [campaignId],
      );
      campaignStatus = String(
        statusRows[0]?.campaign_status ?? campaignStatus,
      ) as LaunchStatus;

      const seStart = resolvedStartDate || resolvedEventDate || resolvedEndDate || "";
      const seEnd = resolvedEndDate || resolvedEventDate || resolvedStartDate || "";
      await insertSuccessEngineDraft(
        connection,
        campaignId,
        body.campaignName.trim(),
        seStart,
        seEnd,
        nonprofitId,
      );
    }

    await connection.query("COMMIT");

    const { rows: inviteRows } = await connection.query<InviteEmailRow>(
      `SELECT it.token, b.business_name, bl.location_name, cbl.acceptance_status, b.contact_email
       FROM campaign_business_locations cbl
       JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       WHERE cbl.campaign_id = $1`,
      [campaignId],
    );

    if (body.launch && !submitLaunchForReview && canInviteBusinesses) {
      await sendBusinessInviteEmails(campaignId);
    }

    res.status(201).json({
      slug,
      /** Additive: needed so guest→signup can link the campaign's nonprofit. */
      nonprofitId,
      campaignStatus,
      campaignName: body.campaignName,
      businessTimingStatus: timingFields.businessTimingStatus,
      forkupReviewStatus: timingFields.forkupReviewStatus,
      timing: timingEval,
      message: body.launch
        ? submitLaunchForReview
          ? "Campaign submitted for ForkUp review"
          : campaignStatus === "invitation_phase"
            ? "Campaign created — waiting on business partners"
            : campaignStatus === "live"
              ? "Campaign created and is now live"
              : "Campaign created — it will appear publicly on the start date"
        : "Campaign saved as draft",
      invitationLinks: inviteRows.map((row) => ({
        businessName: row.business_name,
        locationName: row.location_name,
        token: row.token,
        acceptanceStatus: row.acceptance_status,
        acceptPath: `/?step=business-acceptance&token=${row.token}`,
      })),
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to create campaign" });
  } finally {
    connection.release();
  }
});

/**
 * POST /api/builder/campaigns/:slug/resubmit-forkup-review
 * Body: none
 * Response: { success: true, slug, forkupReviewStatus: "pending" }
 *
 * Purpose: After Super Admin denies a campaign ForkUp review, the nonprofit
 * owner/member can request review again (denied → pending only).
 */
builderRouter.post("/campaigns/:slug/resubmit-forkup-review", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    const slug = req.params.slug.replace(/\/+$/, "");
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, slug, nonprofit_id, created_by_user_id, forkup_review_status
       FROM campaigns WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaign = campaigns[0];
    if (String(campaign.forkup_review_status) !== "denied") {
      res.status(400).json({
        error: "Only a denied ForkUp review can be requested again",
      });
      return;
    }

    const nonprofitId = Number(campaign.nonprofit_id);
    const createdBy =
      campaign.created_by_user_id != null ? Number(campaign.created_by_user_id) : null;
    const isCreator = createdBy != null && createdBy === authUser.id;
    const { rows: membership } = await pool.query<QueryResultRow>(
      `SELECT 1 FROM organization_users
       WHERE organization_type = 'nonprofit'
         AND organization_id = $1
         AND user_id = $2
       LIMIT 1`,
      [nonprofitId, authUser.id],
    );
    if (!authUser.isPlatformAdmin && !isCreator && membership.length === 0) {
      res.status(403).json({ error: "Not allowed to resubmit this campaign" });
      return;
    }

    const { rows: updated } = await pool.query<QueryResultRow>(
      `UPDATE campaigns
       SET forkup_review_status = 'pending',
           forkup_review_requested_at = COALESCE(forkup_review_requested_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND forkup_review_status = 'denied'
       RETURNING slug, forkup_review_status`,
      [campaign.id],
    );
    if (updated.length === 0) {
      res.status(409).json({ error: "Campaign review could not be resubmitted" });
      return;
    }

    res.json({
      success: true,
      slug: String(updated[0].slug),
      forkupReviewStatus: String(updated[0].forkup_review_status),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to resubmit ForkUp review" });
  }
});
