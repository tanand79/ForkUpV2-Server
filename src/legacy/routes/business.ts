import { Router, type Request } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import {
  ensureInvitationToken,
  evaluateCampaignInvitationPhase,
  generateInvitationToken,
} from "../lib/invitations";
import { bearerToken, resolveAuthUser, type AuthUser } from "../lib/auth";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import {
  sendBusinessAcceptedConfirmation,
  sendBusinessDeclinedConfirmation,
} from "../lib/business-lifecycle-emails";
import { METHOD_LABELS, METHOD_REQUIRES_BUSINESS } from "../lib/methods";
import { uniqueCampaignSlug } from "../lib/slug";
import { toDateOnlyString } from "../lib/date-only";
import { evaluateAcceptancePromotionWindow } from "../lib/campaign-timing";
import { deriveSetupReadiness } from "../lib/business-invite-timing";
import {
  syncBusinessInvitationAccepted,
  syncBusinessInvitationDeclined,
  syncBusinessInvitationNeedsInfo,
} from "../lib/business-invitation-record";
import { pool } from "../db/pool";
import type { MethodType } from "../types/campaign";

export const businessRouter = Router();

type InvitationRow = QueryResultRow & {
  id: number;
  campaign_id: number;
  acceptance_status: string;
  invite_status?: string;
  giveback_percentage: number;
  participation_hours: string | null;
  eligible_sales_rules: string | null;
  campaign_slug: string;
  campaign_name: string;
  campaign_story: string;
  campaign_start_date: string | Date | null;
  campaign_end_date: string | Date | null;
  event_date?: string | Date | null;
  campaign_status: string;
  invitation_deadline: string | Date | null;
  organization_name: string;
  business_name: string;
  business_id: number;
  location_id?: number;
  location_name: string;
  city: string;
  state: string;
  method_type: MethodType;
  method_name: string;
  contact_email: string | null;
  token: string | null;
  respond_by_date?: string | Date | null;
  opened_at?: string | Date | null;
  setup_status?: string | null;
  marketing_ready_status?: string | null;
  settlement_ready_status?: string | null;
  message_to_business?: string | null;
  proposed_terms?: string | null;
};

type CollaborationRow = InvitationRow & {
  nonprofit_invite_status: string | null;
};

function formatDate(value: string | Date | null): string | null {
  return toDateOnlyString(value);
}

/**
 * Notifies the nonprofit contact that a business has accepted or declined its
 * campaign invitation. Uses the mailer, which never throws into the flow.
 */
async function notifyNonprofitOfBusinessResponse(
  campaignId: number,
  businessId: number,
  response: "accepted" | "declined",
): Promise<void> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT n.organization_name, n.contact_email, n.contact_name,
            c.campaign_name, c.slug AS campaign_slug, b.business_name
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     JOIN businesses b ON b.id = $2
     WHERE c.id = $1`,
    [campaignId, businessId],
  );
  const row = rows[0];
  const email = typeof row?.contact_email === "string" ? row.contact_email.trim() : "";
  if (!row || !email) return;
  const dashUrl = `${resolveFrontendBaseUrl()}/?step=business-invite-flow&campaign=${row.campaign_slug}`;
  await sendEmail({
    to: email,
    name: typeof row.contact_name === "string" ? row.contact_name : null,
    subject: `${row.business_name} ${response} your ForkUp campaign invitation`,
    body:
      `Hi ${row.organization_name},\n\n` +
      `${row.business_name} has ${response} your invitation to participate in "${row.campaign_name}".\n\n` +
      `View your campaign partners here:\n${dashUrl}\n\n` +
      `— ForkUp`,
    emailType: `business_invite_${response}`,
    campaignId,
    stakeholderRole: "nonprofit",
  });
}

function mapInvitation(row: InvitationRow) {
  return {
    id: row.id,
    token: row.token,
    acceptanceStatus: row.acceptance_status,
    inviteStatus: row.invite_status ?? row.acceptance_status,
    givebackPercentage: Number(row.giveback_percentage),
    participationHours: row.participation_hours,
    eligibleSalesRules: row.eligible_sales_rules,
    messageToBusiness: row.message_to_business ?? null,
    proposedTerms: row.proposed_terms ?? null,
    respondByDate: formatDate(row.respond_by_date ?? null),
    openedAt: row.opened_at ? String(row.opened_at) : null,
    setupStatus: row.setup_status ?? "pending",
    marketingReadyStatus: row.marketing_ready_status ?? "pending",
    settlementReadyStatus: row.settlement_ready_status ?? "pending",
    campaign: {
      slug: row.campaign_slug,
      name: row.campaign_name,
      story: row.campaign_story,
      startDate: formatDate(row.campaign_start_date),
      endDate: formatDate(row.campaign_end_date),
      eventDate: formatDate(row.event_date ?? null),
      status: row.campaign_status,
      invitationDeadline: formatDate(row.invitation_deadline),
      nonprofit: row.organization_name,
    },
    business: {
      id: row.business_id,
      name: row.business_name,
      email: row.contact_email,
    },
    location: {
      id: Number(row.location_id ?? 0) || null,
      name: row.location_name,
      city: row.city,
      state: row.state,
    },
    method: {
      type: row.method_type,
      name: row.method_name || METHOD_LABELS[row.method_type],
    },
  };
}

function maskEmail(email: string | null): string | null {
  if (!email?.includes("@")) return null;
  const [local, domain] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return null;
  const visible = local.length <= 1 ? `${local[0] ?? "*"}*` : `${local[0]}***`;
  return `${visible}@${domain}`;
}

function userMayRespondToBusinessInvite(
  user: AuthUser | null,
  businessId: number,
  contactEmail: string | null,
): boolean {
  if (!user) return false;
  const normalizedContact = contactEmail?.trim().toLowerCase() ?? "";
  if (normalizedContact && user.email.toLowerCase() === normalizedContact) return true;
  return user.organizations.some(
    (o) => o.organizationType === "business" && o.organizationId === businessId,
  );
}

function userMayAccessBusiness(
  user: AuthUser | null,
  businessId: number,
  contactEmail: string | null,
): boolean {
  return userMayRespondToBusinessInvite(user, businessId, contactEmail);
}

function publicInvitationResponse(
  invitation: ReturnType<typeof mapInvitation>,
  user: AuthUser | null,
) {
  const businessId = invitation.business.id;
  const contactEmail = invitation.business.email;
  const canRespond = userMayRespondToBusinessInvite(user, businessId, contactEmail);
  return {
    ...invitation,
    business: {
      id: businessId,
      name: invitation.business.name,
      email: canRespond ? contactEmail : null,
      emailHint: maskEmail(contactEmail),
    },
    canRespond,
  };
}

type InviteContextRow = QueryResultRow & {
  id: number;
  campaign_id: number;
  acceptance_status: string;
  business_id: number;
  contact_email: string | null;
};

async function loadInviteContext(connection: PoolClient, token: string) {
  const { rows: rows } = await connection.query<InviteContextRow>(
    `SELECT cbl.id, cbl.campaign_id, cbl.acceptance_status, cbl.business_id, b.contact_email
     FROM invitation_tokens it
     JOIN campaign_business_locations cbl ON cbl.id = it.campaign_business_location_id
     JOIN businesses b ON b.id = cbl.business_id
     WHERE it.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

async function assertInviteResponder(
  req: Request,
  connection: PoolClient,
  token: string,
) {
  const user = await resolveAuthUser(bearerToken(req));
  if (!user) {
    return {
      ok: false as const,
      status: 401,
      error: "Sign in with the business contact email to respond to this invitation",
    };
  }

  const row = await loadInviteContext(connection, token);
  if (!row) {
    return { ok: false as const, status: 404, error: "Invitation not found" };
  }

  const businessId = Number(row.business_id);
  const contactEmail = row.contact_email ? String(row.contact_email) : null;
  if (!userMayRespondToBusinessInvite(user, businessId, contactEmail)) {
    return {
      ok: false as const,
      status: 403,
      error: contactEmail
        ? `Only ${maskEmail(contactEmail)} or an authorized business admin can respond`
        : "Your account is not authorized to respond to this invitation",
    };
  }

  return { ok: true as const, user, row, businessId };
}

async function linkUserToBusiness(
  connection: PoolClient,
  userId: number,
  businessId: number,
) {
  await connection.query(
    `INSERT INTO organization_users (organization_type, organization_id, user_id, role)
     VALUES ('business', $1, $2, 'admin')
     ON CONFLICT (organization_type, organization_id, user_id) DO NOTHING`,
    [businessId, userId],
  );
}

async function fetchInvitationByToken(token: string) {
  const connection = await pool.connect();
  try {
    const { rows: rows } = await connection.query<InvitationRow>(
      `SELECT
         cbl.id,
         cbl.campaign_id,
         cbl.acceptance_status,
         cbl.invite_status,
         cbl.giveback_percentage,
         cbl.participation_hours,
         cbl.eligible_sales_rules,
         cbl.respond_by_date,
         cbl.opened_at,
         cbl.setup_status,
         cbl.marketing_ready_status,
         cbl.settlement_ready_status,
         cbl.message_to_business,
         cbl.proposed_terms,
         c.slug AS campaign_slug,
         c.campaign_name,
         c.campaign_story,
         c.campaign_start_date,
         c.campaign_end_date,
         c.event_date,
         c.campaign_status,
         c.invitation_deadline,
         n.organization_name,
         b.business_name,
         b.id AS business_id,
         b.contact_email,
         bl.id AS location_id,
         bl.location_name,
         bl.city,
         bl.state,
         cm.method_type,
         cm.method_name,
         it.token
       FROM invitation_tokens it
       JOIN campaign_business_locations cbl ON cbl.id = it.campaign_business_location_id
       JOIN campaigns c ON c.id = cbl.campaign_id
       JOIN nonprofits n ON n.id = c.nonprofit_id
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE it.token = $1`,
      [token],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    if (!row.token) {
      row.token = await ensureInvitationToken(connection, row.id);
    }
    return mapInvitation(row);
  } finally {
    connection.release();
  }
}

businessRouter.get("/collaborations", async (req, res) => {
  try {
    const businessId = Number(req.query.businessId);
    if (!businessId) {
      res.status(400).json({ error: "businessId is required" });
      return;
    }

    const user = await resolveAuthUser(bearerToken(req));
    const { rows: bizRows } = await pool.query<QueryResultRow>(
      "SELECT id, contact_email FROM businesses WHERE id = $1",
      [businessId],
    );
    if (bizRows.length === 0) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const contactEmail = bizRows[0].contact_email as string | null;
    const normalizedEmail = contactEmail?.trim().toLowerCase() ?? null;
    if (!userMayAccessBusiness(user, businessId, contactEmail)) {
      res.status(401).json({ error: "Not authorized to view these collaborations" });
      return;
    }

    const connection = await pool.connect();
    try {
      const { rows: rows } = await connection.query<CollaborationRow>(
        `SELECT
           cbl.id,
           cbl.campaign_id,
           cbl.acceptance_status,
           cbl.invite_status,
           cbl.respond_by_date,
           cbl.setup_status,
           cbl.marketing_ready_status,
           cbl.settlement_ready_status,
           cbl.giveback_percentage,
           cbl.participation_hours,
           cbl.eligible_sales_rules,
           cbl.message_to_business,
           cbl.proposed_terms,
           c.slug AS campaign_slug,
           c.campaign_name,
           c.campaign_story,
           c.campaign_start_date,
           c.campaign_end_date,
           c.campaign_status,
           c.invitation_deadline,
           n.organization_name,
           b.business_name,
           b.id AS business_id,
           b.contact_email,
           bl.id AS location_id,
           bl.location_name,
           bl.city,
           bl.state,
           cm.method_type,
           cm.method_name,
           it.token,
           nci.invitation_status AS nonprofit_invite_status
         FROM campaign_business_locations cbl
         JOIN businesses b ON b.id = cbl.business_id
         JOIN business_locations bl ON bl.id = cbl.location_id
         JOIN campaigns c ON c.id = cbl.campaign_id
         JOIN nonprofits n ON n.id = c.nonprofit_id
         JOIN campaign_methods cm ON cm.id = cbl.method_id
         LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
         LEFT JOIN nonprofit_campaign_invitations nci
           ON nci.campaign_id = c.id AND nci.business_id = cbl.business_id
         WHERE cbl.acceptance_status != 'declined'
           AND (
             cbl.business_id = $1
             OR ($2::text IS NOT NULL AND LOWER(b.contact_email) = $3)
           )
         ORDER BY c.updated_at DESC, c.campaign_start_date DESC`,
        [businessId, normalizedEmail, normalizedEmail],
      );

      const collaborations = [];
      for (const row of rows) {
        if (
          !row.token &&
          ["invited", "pending", "opened", "changes_requested", "needs_info"].includes(
            row.acceptance_status,
          )
        ) {
          row.token = await ensureInvitationToken(connection, row.id);
        }
        const mapped = mapInvitation(row);
        collaborations.push({
          ...mapped,
          reviewPath: row.token ? `/?step=business-acceptance&token=${row.token}` : null,
          direction: row.nonprofit_invite_status != null ? "outgoing" : "incoming",
          nonprofitInviteStatus: row.nonprofit_invite_status,
        });
      }

      res.json(collaborations);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch collaborations" });
  }
});

businessRouter.get("/invitations", async (req, res) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email.includes("@")) {
      res.status(400).json({ error: "Valid business email is required" });
      return;
    }

    const connection = await pool.connect();
    try {
      const { rows: rows } = await connection.query<InvitationRow>(
        `SELECT
           cbl.id,
           cbl.campaign_id,
           cbl.acceptance_status,
           cbl.giveback_percentage,
           cbl.participation_hours,
           cbl.eligible_sales_rules,
           cbl.message_to_business,
           cbl.proposed_terms,
           c.slug AS campaign_slug,
           c.campaign_name,
           c.campaign_story,
           c.campaign_start_date,
           c.campaign_end_date,
           c.campaign_status,
           c.invitation_deadline,
           n.organization_name,
           b.business_name,
           b.id AS business_id,
           b.contact_email,
           bl.id AS location_id,
           bl.location_name,
           bl.city,
           bl.state,
           cm.method_type,
           cm.method_name,
           it.token
         FROM campaign_business_locations cbl
         JOIN businesses b ON b.id = cbl.business_id
         JOIN business_locations bl ON bl.id = cbl.location_id
         JOIN campaigns c ON c.id = cbl.campaign_id
         JOIN nonprofits n ON n.id = c.nonprofit_id
         JOIN campaign_methods cm ON cm.id = cbl.method_id
         LEFT JOIN invitation_tokens it ON it.campaign_business_location_id = cbl.id
         WHERE LOWER(b.contact_email) = $1
           AND cbl.acceptance_status IN ('invited', 'pending', 'opened', 'changes_requested', 'needs_info')
         ORDER BY c.campaign_start_date ASC`,
        [email],
      );

      const invitations = [];
      for (const row of rows) {
        if (!row.token) {
          row.token = await ensureInvitationToken(connection, row.id);
        }
        invitations.push(mapInvitation(row));
      }

      res.json(invitations);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invitations" });
  }
});

businessRouter.get("/invitations/:token", async (req, res) => {
  try {
    // Stamp opened on first view (Nick V2 Layer 3) — does not change accepted/declined.
    await pool.query(
      `UPDATE campaign_business_locations cbl
       SET
         acceptance_status = CASE
           WHEN acceptance_status IN ('invited', 'pending') THEN 'opened'
           ELSE acceptance_status
         END,
         invite_status = CASE
           WHEN invite_status IN ('invited', 'pending', 'draft') THEN 'opened'
           ELSE invite_status
         END,
         opened_at = COALESCE(opened_at, NOW()),
         updated_at = NOW()
       FROM invitation_tokens it
       WHERE it.token = $1
         AND it.campaign_business_location_id = cbl.id
         AND cbl.acceptance_status IN ('invited', 'pending', 'opened')`,
      [req.params.token],
    );
    await pool.query(
      `UPDATE business_invitations bi
       SET
         invitation_status = CASE
           WHEN invitation_status IN ('sent', 'draft', 'invited') THEN 'opened'
           ELSE invitation_status
         END,
         opened_at = COALESCE(opened_at, NOW())
       FROM invitation_tokens it
       WHERE it.token = $1
         AND it.campaign_business_location_id = bi.campaign_business_location_id
         AND bi.invitation_status IN ('sent', 'draft', 'invited', 'opened')`,
      [req.params.token],
    );

    const invitation = await fetchInvitationByToken(req.params.token);
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const user = await resolveAuthUser(bearerToken(req));
    res.json(publicInvitationResponse(invitation, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invitation" });
  }
});

businessRouter.post("/invitations/:token/accept", async (req, res) => {
  const connection = await pool.connect();
  try {
    const {
      authorizedRepresentative,
      eligibleSalesRules,
      participationHours,
      billingContactName,
      billingContactEmail,
      settlementContactName,
      settlementContactEmail,
      forkupFeeAcknowledged,
      net7Acknowledged,
      achAuthorized,
    } = req.body as Record<string, unknown>;

    if (!authorizedRepresentative || typeof authorizedRepresentative !== "string") {
      res.status(400).json({ error: "Authorized representative is required" });
      return;
    }
    if (!forkupFeeAcknowledged || !net7Acknowledged || !achAuthorized) {
      res.status(400).json({ error: "All terms and ACH authorization must be confirmed" });
      return;
    }

    await connection.query("BEGIN");

    const access = await assertInviteResponder(req, connection, req.params.token);
    if (!access.ok) {
      await connection.query("ROLLBACK");
      res.status(access.status).json({ error: access.error });
      return;
    }

    const invite = access.row;
    if (
      !["invited", "pending", "opened", "changes_requested", "needs_info"].includes(
        String(invite.acceptance_status),
      )
    ) {
      await connection.query("ROLLBACK");
      res.status(400).json({ error: "This invitation has already been responded to" });
      return;
    }

    const cblId = Number(invite.id);
    const campaignId = Number(invite.campaign_id);

    await linkUserToBusiness(connection, access.user.id, access.businessId);

    const setup = deriveSetupReadiness({
      achAuthorized: Boolean(achAuthorized),
      billingContactEmail:
        typeof billingContactEmail === "string" ? billingContactEmail : null,
      settlementContactEmail:
        typeof settlementContactEmail === "string" ? settlementContactEmail : null,
      authorizedRepresentative:
        typeof authorizedRepresentative === "string"
          ? authorizedRepresentative
          : null,
    });

    await connection.query(
      `UPDATE campaign_business_locations SET
        acceptance_status = 'accepted',
        invite_status = $4,
        participation_hours = COALESCE($1, participation_hours),
        eligible_sales_rules = COALESCE($2, eligible_sales_rules),
        terms_confirmed = TRUE,
        ach_authorized = TRUE,
        setup_status = $5,
        marketing_ready_status = $6,
        settlement_ready_status = $7,
        updated_at = NOW()
       WHERE id = $3`,
      [
        typeof participationHours === "string" ? participationHours : null,
        typeof eligibleSalesRules === "string" ? eligibleSalesRules : null,
        cblId,
        setup.inviteStatusAfterAccept,
        setup.setupStatus,
        setup.marketingReadyStatus,
        setup.settlementReadyStatus,
      ],
    );

    await connection.query(
      `INSERT INTO business_acceptances (
        campaign_business_location_id, authorized_representative, eligible_sales_rules,
        forkup_fee_acknowledged, net7_acknowledged, ach_authorized,
        billing_contact_name, billing_contact_email,
        settlement_contact_name, settlement_contact_email, accepted_at
      ) VALUES ($1, $2, $3, TRUE, TRUE, TRUE, $4, $5, $6, $7, NOW())
       ON CONFLICT (campaign_business_location_id) DO UPDATE SET
        authorized_representative = EXCLUDED.authorized_representative,
        eligible_sales_rules = EXCLUDED.eligible_sales_rules,
        forkup_fee_acknowledged = TRUE,
        net7_acknowledged = TRUE,
        ach_authorized = TRUE,
        billing_contact_name = EXCLUDED.billing_contact_name,
        billing_contact_email = EXCLUDED.billing_contact_email,
        settlement_contact_name = EXCLUDED.settlement_contact_name,
        settlement_contact_email = EXCLUDED.settlement_contact_email,
        accepted_at = NOW(),
        updated_at = NOW()`,
      [
        cblId,
        authorizedRepresentative.trim(),
        typeof eligibleSalesRules === "string" ? eligibleSalesRules : null,
        typeof billingContactName === "string" ? billingContactName : null,
        typeof billingContactEmail === "string" ? billingContactEmail : null,
        typeof settlementContactName === "string" ? settlementContactName : null,
        typeof settlementContactEmail === "string" ? settlementContactEmail : null,
      ],
    );

    await syncBusinessInvitationAccepted(connection, {
      campaignBusinessLocationId: cblId,
      invitationStatus: setup.inviteStatusAfterAccept,
      setupStatus: setup.setupStatus,
      marketingReadyStatus: setup.marketingReadyStatus,
      settlementReadyStatus: setup.settlementReadyStatus,
    });

    await connection.query(
      `UPDATE businesses SET business_status = 'active', claim_status = 'claimed', updated_at = NOW()
       WHERE id = (SELECT business_id FROM campaign_business_locations WHERE id = $1)`,
      [cblId],
    );

    await evaluateCampaignInvitationPhase(connection, campaignId);

    // Nick V2 Layer 2: acceptance inside 21 days of start/event → limited promotion window.
    const { rows: timingRows } = await connection.query<QueryResultRow>(
      `SELECT c.campaign_start_date, c.event_date, cbl.method_id
       FROM campaigns c
       JOIN campaign_business_locations cbl ON cbl.campaign_id = c.id
       WHERE cbl.id = $1`,
      [cblId],
    );
    const timingRow = timingRows[0];
    const anchorDate =
      timingRow?.event_date ?? timingRow?.campaign_start_date ?? null;
    const promoStatus = evaluateAcceptancePromotionWindow({
      startOrEventDate: anchorDate ? String(anchorDate) : null,
    });
    if (promoStatus === "limited_promotion_window") {
      await connection.query(
        `UPDATE campaigns SET
           business_timing_status = CASE
             WHEN business_timing_status = 'needs_forkup_review' THEN business_timing_status
             ELSE 'limited_promotion_window'
           END,
           updated_at = NOW()
         WHERE id = $1`,
        [campaignId],
      );
      if (timingRow?.method_id) {
        await connection.query(
          `UPDATE campaign_methods SET
             timing_status = CASE
               WHEN timing_status = 'needs_forkup_review' THEN timing_status
               ELSE 'limited_promotion_window'
             END,
             updated_at = NOW()
           WHERE id = $1`,
          [timingRow.method_id],
        );
      }
    }

    await connection.query("COMMIT");

    await notifyNonprofitOfBusinessResponse(campaignId, access.businessId, "accepted");
    // Nick V2 Layer 5 Email 3 — business confirmation (additive; nonprofit notify above stays).
    await sendBusinessAcceptedConfirmation(campaignId, access.businessId);

    res.json({
      success: true,
      acceptanceStatus: "accepted",
      inviteStatus: setup.inviteStatusAfterAccept,
      setupStatus: setup.setupStatus,
      marketingReadyStatus: setup.marketingReadyStatus,
      settlementReadyStatus: setup.settlementReadyStatus,
      timingStatus: promoStatus,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to accept invitation" });
  } finally {
    connection.release();
  }
});

businessRouter.post("/invitations/:token/decline", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { reason } = req.body as { reason?: string };
    await connection.query("BEGIN");

    const access = await assertInviteResponder(req, connection, req.params.token);
    if (!access.ok) {
      await connection.query("ROLLBACK");
      res.status(access.status).json({ error: access.error });
      return;
    }

    const invite = access.row;
    const cblId = Number(invite.id);
    const campaignId = Number(invite.campaign_id);

    await linkUserToBusiness(connection, access.user.id, access.businessId);

    await connection.query(
      `UPDATE campaign_business_locations SET
        acceptance_status = 'declined', invite_status = 'declined', updated_at = NOW()
       WHERE id = $1`,
      [cblId],
    );

    await connection.query<{ id: number }>(
      `INSERT INTO business_acceptances (campaign_business_location_id, authorized_representative, declined_at, decline_reason)
       VALUES ($1, 'N/A', NOW(), $2)
       ON CONFLICT (campaign_business_location_id) DO UPDATE SET
         declined_at = NOW(),
         decline_reason = EXCLUDED.decline_reason,
         updated_at = NOW()
       RETURNING id`,
      [cblId, reason ?? null],
    );

    await syncBusinessInvitationDeclined(connection, {
      campaignBusinessLocationId: cblId,
      declineReason: reason ?? null,
    });

    await evaluateCampaignInvitationPhase(connection, campaignId);
    await connection.query("COMMIT");

    await notifyNonprofitOfBusinessResponse(campaignId, access.businessId, "declined");
    // Nick V2 Layer 5 Email 4 — business confirmation (additive; nonprofit notify above stays).
    await sendBusinessDeclinedConfirmation(campaignId, access.businessId);

    res.json({ success: true, acceptanceStatus: "declined" });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to decline invitation" });
  } finally {
    connection.release();
  }
});

businessRouter.post("/invitations/:token/request-changes", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { message } = req.body as { message?: string };
    if (!message?.trim()) {
      res.status(400).json({ error: "Please describe the changes requested" });
      return;
    }

    await connection.query("BEGIN");

    const access = await assertInviteResponder(req, connection, req.params.token);
    if (!access.ok) {
      await connection.query("ROLLBACK");
      res.status(access.status).json({ error: access.error });
      return;
    }

    const cblId = Number(access.row.id);
    const messageText = message.trim();

    await linkUserToBusiness(connection, access.user.id, access.businessId);

    const { rows: scopeRows } = await connection.query<QueryResultRow>(
      `SELECT cbl.campaign_id, cbl.business_id, b.contact_email
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       WHERE cbl.id = $1`,
      [cblId],
    );
    const scope = scopeRows[0];
    const campaignId = Number(scope?.campaign_id);
    const businessId = Number(scope?.business_id);
    const contactEmail = String(scope?.contact_email ?? "").trim().toLowerCase();

    await connection.query(
      `UPDATE campaign_business_locations AS cbl
       SET acceptance_status = 'changes_requested',
           invite_status = 'changes_requested',
           updated_at = NOW()
       FROM businesses b
       WHERE b.id = cbl.business_id
         AND cbl.campaign_id = $1
         AND (
           cbl.business_id = $2
           OR ($3::text != '' AND LOWER(TRIM(b.contact_email)) = $4)
         )`,
      [campaignId, businessId, contactEmail, contactEmail],
    );

    const { rows: siblingRows } = await connection.query<QueryResultRow>(
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

    for (const row of siblingRows) {
      await connection.query(
        `INSERT INTO business_acceptances (campaign_business_location_id, authorized_representative, change_request_message)
         VALUES ($1, 'Pending', $2)
         ON CONFLICT (campaign_business_location_id) DO UPDATE SET
           change_request_message = EXCLUDED.change_request_message,
           updated_at = NOW()`,
        [row.id, messageText],
      );
    }

    await syncBusinessInvitationNeedsInfo(
      connection,
      siblingRows.map((row) => Number(row.id)),
    );

    await connection.query("COMMIT");
    res.json({ success: true, acceptanceStatus: "changes_requested" });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to submit change request" });
  } finally {
    connection.release();
  }
});

const BUSINESS_INITIATED_METHODS: MethodType[] = [
  "dine_and_donate",
  "shop_and_donate",
  "service_giveback",
  "guest_bartending_event",
];

function defaultCampaignDates() {
  const start = new Date();
  start.setDate(start.getDate() + 14);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return {
    startDate: toDateOnlyString(start) ?? "",
    endDate: toDateOnlyString(end) ?? "",
  };
}

businessRouter.post("/nonprofit-invites", async (req, res) => {
  const connection = await pool.connect();
  try {
    const body = req.body as {
      businessId?: number;
      locationId?: number;
      nonprofitId?: number;
      methodType?: MethodType;
      givebackPercentage?: number;
      message?: string;
      campaignName?: string;
    };

    const businessId = Number(body.businessId);
    const locationId = Number(body.locationId);
    const nonprofitId = Number(body.nonprofitId);
    const methodType = body.methodType;

    if (!businessId || !locationId || !nonprofitId) {
      res.status(400).json({ error: "businessId, locationId, and nonprofitId are required" });
      return;
    }
    if (!methodType || !BUSINESS_INITIATED_METHODS.includes(methodType)) {
      res.status(400).json({ error: "A valid business fundraising method is required" });
      return;
    }
    if (!METHOD_REQUIRES_BUSINESS[methodType]) {
      res.status(400).json({ error: "This method cannot be initiated by a business invite" });
      return;
    }

    const { rows: bizRows } = await connection.query<QueryResultRow>(
      "SELECT * FROM businesses WHERE id = $1",
      [businessId],
    );
    if (bizRows.length === 0) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const business = bizRows[0];

    const { rows: locRows } = await connection.query<QueryResultRow>(
      "SELECT * FROM business_locations WHERE id = $1 AND business_id = $2",
      [locationId, businessId],
    );
    if (locRows.length === 0) {
      res.status(400).json({ error: "Location does not belong to this business" });
      return;
    }

    const { rows: npRows } = await connection.query<QueryResultRow>(
      "SELECT * FROM nonprofits WHERE id = $1",
      [nonprofitId],
    );
    if (npRows.length === 0) {
      res.status(404).json({ error: "Nonprofit not found" });
      return;
    }
    const nonprofit = npRows[0];

    const giveback = Number(body.givebackPercentage ?? business.default_giveback_percentage ?? 10);
    const { startDate, endDate } = defaultCampaignDates();
    const methodLabel = METHOD_LABELS[methodType];
    const campaignName =
      body.campaignName?.trim() ||
      `${business.business_name} × ${nonprofit.organization_name} — ${methodLabel}`;

    await connection.query("BEGIN");

    const slug = await uniqueCampaignSlug(campaignName, async (s) => {
      const { rows: rows } = await connection.query<QueryResultRow>(
        "SELECT id FROM campaigns WHERE slug = $1",
        [s],
      );
      return rows.length > 0;
    });

    const story =
      body.message?.trim() ||
      `${business.business_name} has invited ${nonprofit.organization_name} to run a ${methodLabel} campaign on ForkUp. Accept this invitation to complete your campaign details and launch.`;

    const { rows: campResult } = await connection.query<{ id: number }>(
      `INSERT INTO campaigns (
        slug, nonprofit_id, campaign_name, campaign_story, campaign_goal,
        campaign_start_date, campaign_end_date, campaign_status, cover_image_url,
        invitation_deadline
      ) VALUES ($1, $2, $3, $4, 0, $5, $6, 'draft', '/placeholder-cover.jpg', $7::date - INTERVAL '7 days') RETURNING id`,
      [slug, nonprofitId, campaignName, story, startDate, endDate, startDate],
    );
    const campaignId = campResult[0].id;

    const { rows: methodResult } = await connection.query<{ id: number }>(
      `INSERT INTO campaign_methods (
        campaign_id, method_type, method_name, method_start_date, method_end_date,
        method_status, requires_business_acceptance
      ) VALUES ($1, $2, $3, $4, $5, 'pending_acceptance', TRUE) RETURNING id`,
      [campaignId, methodType, methodLabel, startDate, endDate],
    );
    const methodId = methodResult[0].id;

    const { rows: cblResult } = await connection.query<{ id: number }>(
      `INSERT INTO campaign_business_locations (
        campaign_id, method_id, business_id, location_id,
        invite_status, acceptance_status, giveback_percentage, terms_confirmed, ach_authorized
      ) VALUES ($1, $2, $3, $4, 'accepted', 'accepted', $5, TRUE, TRUE) RETURNING id`,
      [campaignId, methodId, businessId, locationId, giveback],
    );
    await ensureInvitationToken(connection, cblResult[0].id);

    const token = generateInvitationToken();
    await connection.query(
      `INSERT INTO nonprofit_campaign_invitations (
        token, business_id, location_id, nonprofit_id, campaign_id, method_id,
        method_type, giveback_percentage, message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        token,
        businessId,
        locationId,
        nonprofitId,
        campaignId,
        methodId,
        methodType,
        giveback,
        body.message?.trim() ?? null,
      ],
    );

    await connection.query("COMMIT");

    const acceptPath = `/?step=nonprofit-accepts-invite&token=${token}`;
    const nonprofitEmail =
      typeof nonprofit.contact_email === "string" ? nonprofit.contact_email.trim() : "";
    if (nonprofitEmail) {
      const acceptUrl = `${resolveFrontendBaseUrl()}${acceptPath}`;
      await sendEmail({
        to: nonprofitEmail,
        name: typeof nonprofit.contact_name === "string" ? nonprofit.contact_name : null,
        subject: `${business.business_name} invited ${nonprofit.organization_name} to a ForkUp campaign`,
        body:
          `Hi ${nonprofit.organization_name},\n\n` +
          `${business.business_name} would like to run a ${methodLabel} campaign with you on ForkUp` +
          `${giveback ? ` (giveback: ${giveback}%)` : ""}.\n\n` +
          (body.message?.trim() ? `Message from ${business.business_name}:\n${body.message.trim()}\n\n` : "") +
          `Review and respond to the invitation here:\n${acceptUrl}\n\n` +
          `— ForkUp`,
        emailType: "nonprofit_campaign_invitation",
        campaignId,
        stakeholderRole: "nonprofit",
        relatedToken: token,
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
    res.status(500).json({ error: "Failed to send nonprofit invitation" });
  } finally {
    connection.release();
  }
});

businessRouter.get("/nonprofit-invites/:token", async (req, res) => {
  try {
    const { rows: rows } = await pool.query<QueryResultRow>(
      `SELECT
         nci.*,
         b.business_name, b.contact_email AS business_email,
         bl.location_name, bl.city, bl.state,
         n.organization_name, n.contact_email AS nonprofit_email,
         c.slug AS campaign_slug, c.campaign_name, c.campaign_story,
         c.campaign_start_date, c.campaign_end_date, c.campaign_status
       FROM nonprofit_campaign_invitations nci
       JOIN businesses b ON b.id = nci.business_id
       JOIN business_locations bl ON bl.id = nci.location_id
       JOIN nonprofits n ON n.id = nci.nonprofit_id
       JOIN campaigns c ON c.id = nci.campaign_id
       WHERE nci.token = $1`,
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
      givebackPercentage: Number(row.giveback_percentage),
      message: row.message,
      method: {
        type: row.method_type,
        name: METHOD_LABELS[row.method_type as MethodType] ?? row.method_type,
      },
      business: {
        id: row.business_id,
        name: row.business_name,
        email: row.business_email,
      },
      location: {
        id: row.location_id,
        name: row.location_name,
        city: row.city,
        state: row.state,
      },
      nonprofit: {
        id: row.nonprofit_id,
        name: row.organization_name,
        email: row.nonprofit_email,
      },
      campaign: {
        slug: row.campaign_slug,
        name: row.campaign_name,
        story: row.campaign_story,
        startDate: formatDate(row.campaign_start_date),
        endDate: formatDate(row.campaign_end_date),
        status: row.campaign_status,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invitation" });
  }
});

businessRouter.post("/nonprofit-invites/:token/accept", async (req, res) => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows: rows } = await connection.query<QueryResultRow>(
      `SELECT * FROM nonprofit_campaign_invitations WHERE token = $1`,
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
      `UPDATE nonprofit_campaign_invitations
       SET invitation_status = 'accepted', responded_at = NOW()
       WHERE id = $1`,
      [invite.id],
    );

    await connection.query(
      `UPDATE campaign_methods SET method_status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [invite.method_id],
    );

    const { rows: campaign } = await connection.query<QueryResultRow>(
      "SELECT slug FROM campaigns WHERE id = $1",
      [invite.campaign_id],
    );

    await connection.query("COMMIT");
    res.json({
      success: true,
      invitationStatus: "accepted",
      campaignSlug: campaign[0]?.slug,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to accept invitation" });
  } finally {
    connection.release();
  }
});

businessRouter.post("/nonprofit-invites/:token/decline", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { reason } = req.body as { reason?: string };
    await connection.query("BEGIN");

    const { rows: rows } = await connection.query<QueryResultRow>(
      `SELECT * FROM nonprofit_campaign_invitations WHERE token = $1`,
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
      `UPDATE nonprofit_campaign_invitations
       SET invitation_status = 'declined', responded_at = NOW(), message = COALESCE($1, message)
       WHERE id = $2`,
      [reason?.trim() ?? null, invite.id],
    );

    await connection.query(
      `UPDATE campaign_methods SET method_status = 'closed', updated_at = NOW() WHERE id = $1`,
      [invite.method_id],
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
