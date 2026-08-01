/**
 * Campaign AI guidance API (Nick V2 Layer 4).
 *
 * Hard rules stay in campaign-timing / invite libs. These endpoints explain,
 * score, generate calendars, and surface health nudges — AI is optional polish.
 *
 * Mounted at /api/campaign-ai
 */
import { Router } from "express";
import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { toDateOnlyString } from "../lib/date-only";
import type { MethodType } from "../types/campaign";
import {
  buildTimingGuidance,
  describeMethods,
  polishGuidanceWithAi,
  recommendMethodMix,
  scoreInviteReadiness,
} from "../lib/campaign-ai-guidance";
import { buildSuccessEngineCalendar } from "../lib/success-engine-calendar";
import { aiProviderName } from "../lib/ai-chat";

export const campaignAiRouter = Router();

type GuidanceBody = {
  campaignId?: number;
  slug?: string;
  methods?: MethodType[];
  startDate?: string;
  endDate?: string;
  eventDate?: string;
  campaignName?: string;
  nonprofitName?: string;
  goal?: number;
  hasStory?: boolean;
  hasCover?: boolean;
  hasNonprofitProfile?: boolean;
  hasBusinessContacts?: boolean;
  invitedBusinessCount?: number;
  forkupReviewStatus?: string;
  persist?: boolean;
};

async function loadCampaignBySlug(slug: string) {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT c.id, c.slug, c.campaign_name, c.campaign_story, c.campaign_goal,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            c.cover_image_url, c.business_timing_status, c.forkup_review_status,
            n.organization_name, n.id AS nonprofit_id
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

async function loadCampaignMethods(campaignId: number): Promise<MethodType[]> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT method_type FROM campaign_methods WHERE campaign_id = $1`,
    [campaignId],
  );
  return rows.map((r) => r.method_type as MethodType);
}

async function persistInsight(input: {
  campaignId: number;
  insightType: string;
  score?: number | null;
  summary: string;
  payload: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO campaign_ai_insights (campaign_id, insight_type, score, summary, payload_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.campaignId,
      input.insightType,
      input.score ?? null,
      input.summary,
      JSON.stringify(input.payload),
    ],
  );
}

/**
 * POST /api/campaign-ai/timing-guidance
 * Body: methods, dates, optional slug/campaignId
 * Response: { timing, summary, aiExplanation, provider }
 */
campaignAiRouter.post("/timing-guidance", async (req, res) => {
  try {
    const body = req.body as GuidanceBody;
    let methods = body.methods ?? [];
    let startDate = body.startDate;
    let eventDate = body.eventDate;
    let forkupReviewStatus = body.forkupReviewStatus;
    let campaignId = body.campaignId;

    if (body.slug) {
      const camp = await loadCampaignBySlug(body.slug.replace(/\/+$/, ""));
      if (!camp) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      campaignId = Number(camp.id);
      methods = methods.length ? methods : await loadCampaignMethods(campaignId);
      startDate = startDate || toDateOnlyString(camp.campaign_start_date) || undefined;
      eventDate = eventDate || toDateOnlyString(camp.event_date) || undefined;
      forkupReviewStatus =
        forkupReviewStatus || String(camp.forkup_review_status || "none");
    }

    const result = buildTimingGuidance({
      methods,
      startDate,
      eventDate,
      forkupReviewStatus,
    });

    const aiExplanation = await polishGuidanceWithAi({
      systemHint: "Explain this campaign timing assessment to a nonprofit organizer.",
      facts: `${result.summary}\nMethods: ${describeMethods(methods)}\nStatus: ${result.timing.status}\nDays: ${result.timing.daysUntilAnchor}\nMessage: ${result.timing.message ?? ""}`,
    });
    result.aiExplanation = aiExplanation;

    if (body.persist && campaignId) {
      await persistInsight({
        campaignId,
        insightType: "timing_guidance",
        summary: result.summary,
        payload: { ...result },
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build timing guidance" });
  }
});

/**
 * POST /api/campaign-ai/method-mix
 * Body: optional methods/dates/goal
 * Response: { recommended, summary, aiExplanation, provider }
 */
campaignAiRouter.post("/method-mix", async (req, res) => {
  try {
    const body = req.body as GuidanceBody;
    const result = recommendMethodMix({
      methods: body.methods,
      startDate: body.startDate,
      eventDate: body.eventDate,
      endDate: body.endDate,
      goal: body.goal,
    });
    result.aiExplanation = await polishGuidanceWithAi({
      systemHint: "Recommend a fundraising method mix for this nonprofit campaign.",
      facts: result.summary,
    });

    if (body.persist && body.campaignId) {
      await persistInsight({
        campaignId: body.campaignId,
        insightType: "method_mix",
        summary: result.summary,
        payload: { ...result },
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to recommend method mix" });
  }
});

/**
 * POST /api/campaign-ai/invite-readiness
 * Body: readiness factors + methods/dates
 * Response: { score, summary, factors, aiExplanation, provider }
 */
campaignAiRouter.post("/invite-readiness", async (req, res) => {
  try {
    const body = req.body as GuidanceBody;
    let methods = body.methods ?? [];
    let campaignId = body.campaignId;

    if (body.slug) {
      const camp = await loadCampaignBySlug(body.slug.replace(/\/+$/, ""));
      if (!camp) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      campaignId = Number(camp.id);
      methods = methods.length ? methods : await loadCampaignMethods(campaignId);
      const { rows: partnerRows } = await pool.query<QueryResultRow>(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE LOWER(COALESCE(b.contact_email,'')) LIKE '%@%')::int AS with_email
         FROM campaign_business_locations cbl
         JOIN businesses b ON b.id = cbl.business_id
         WHERE cbl.campaign_id = $1`,
        [campaignId],
      );
      body.invitedBusinessCount = Number(partnerRows[0]?.n ?? 0);
      body.hasBusinessContacts = Number(partnerRows[0]?.with_email ?? 0) > 0;
      body.hasStory = Boolean(String(camp.campaign_story || "").trim());
      body.hasCover = Boolean(String(camp.cover_image_url || "").trim());
      body.hasNonprofitProfile = true;
      body.startDate =
        body.startDate || toDateOnlyString(camp.campaign_start_date) || undefined;
      body.endDate =
        body.endDate || toDateOnlyString(camp.campaign_end_date) || undefined;
      body.eventDate =
        body.eventDate || toDateOnlyString(camp.event_date) || undefined;
    }

    const result = scoreInviteReadiness({
      methods,
      startDate: body.startDate,
      endDate: body.endDate,
      eventDate: body.eventDate,
      hasStory: body.hasStory,
      hasCover: body.hasCover,
      hasNonprofitProfile: body.hasNonprofitProfile,
      hasBusinessContacts: body.hasBusinessContacts,
      invitedBusinessCount: body.invitedBusinessCount,
    });

    result.aiExplanation = await polishGuidanceWithAi({
      systemHint: "Coach the nonprofit on business invite readiness.",
      facts: `${result.summary}\nFactors: ${JSON.stringify(result.factors)}`,
    });

    if (body.persist && campaignId) {
      await persistInsight({
        campaignId,
        insightType: "invite_readiness",
        score: result.score,
        summary: result.summary,
        payload: { ...result },
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to score invite readiness" });
  }
});

/**
 * POST /api/campaign-ai/generate-calendar
 * Body: { slug } or campaign fields
 * Response: { created, actions, provider }
 * Skips business promo actions until a business has accepted.
 */
campaignAiRouter.post("/generate-calendar", async (req, res) => {
  try {
    const body = req.body as GuidanceBody;
    if (!body.slug) {
      res.status(400).json({ error: "slug is required" });
      return;
    }
    const slug = body.slug.replace(/\/+$/, "");
    const camp = await loadCampaignBySlug(slug);
    if (!camp) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(camp.id);
    const methods = await loadCampaignMethods(campaignId);

    const { rows: accepted } = await pool.query<QueryResultRow>(
      `SELECT id FROM campaign_business_locations
       WHERE campaign_id = $1 AND acceptance_status IN ('accepted', 'ready', 'live', 'completed')
       LIMIT 1`,
      [campaignId],
    );

    const drafts = buildSuccessEngineCalendar({
      campaignName: String(camp.campaign_name),
      methods,
      startDate: toDateOnlyString(camp.campaign_start_date),
      eventDate: toDateOnlyString(camp.event_date),
      endDate: toDateOnlyString(camp.campaign_end_date),
      nonprofitName: String(camp.organization_name),
      hasAcceptedBusiness: accepted.length > 0,
    });

    let created = 0;
    for (const draft of drafts) {
      const { rows: existing } = await pool.query<QueryResultRow>(
        `SELECT id FROM success_engine_actions
         WHERE campaign_id = $1 AND action_type = $2 AND scheduled_date = $3
         LIMIT 1`,
        [campaignId, draft.action_type, draft.scheduled_date],
      );
      if (existing.length > 0) continue;

      await pool.query(
        `INSERT INTO success_engine_actions (
           campaign_id, action_type, channel, scheduled_date, title, content,
           status, stakeholder_role, generated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)`,
        [
          campaignId,
          draft.action_type,
          draft.channel,
          draft.scheduled_date,
          draft.title,
          draft.content,
          draft.stakeholder_role,
          draft.generated_by,
        ],
      );
      created += 1;
    }

    const summary = `Generated Success Engine calendar: ${created} new action(s) for "${camp.campaign_name}".`;
    await persistInsight({
      campaignId,
      insightType: "calendar_plan",
      summary,
      payload: { created, totalDrafts: drafts.length, provider: aiProviderName() },
    });

    res.json({
      success: true,
      created,
      totalDrafts: drafts.length,
      actions: drafts,
      provider: aiProviderName(),
      message: summary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate Success Engine calendar" });
  }
});

/**
 * GET /api/campaign-ai/:slug/health
 * Response: { nudges: [{ severity, message, cta? }], provider }
 */
campaignAiRouter.get("/:slug/health", async (req, res) => {
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    const camp = await loadCampaignBySlug(slug);
    if (!camp) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(camp.id);
    const nudges: { severity: "info" | "warn" | "critical"; message: string }[] =
      [];

    const { rows: partners } = await pool.query<QueryResultRow>(
      `SELECT acceptance_status, setup_status, settlement_ready_status, respond_by_date
       FROM campaign_business_locations WHERE campaign_id = $1`,
      [campaignId],
    );
    const pending = partners.filter((p) =>
      ["invited", "pending", "opened"].includes(String(p.acceptance_status)),
    );
    const accepted = partners.filter((p) =>
      ["accepted", "ready", "live", "completed"].includes(String(p.acceptance_status)),
    );
    const missingPayment = accepted.filter(
      (p) => String(p.settlement_ready_status) === "needs_info",
    );

    if (pending.length > 0) {
      nudges.push({
        severity: "warn",
        message: `${pending.length} business${pending.length === 1 ? " has" : "es have"} not responded yet. Send a reminder before the respond-by date.`,
      });
    }
    if (partners.length > 0 && accepted.length === 0) {
      nudges.push({
        severity: "info",
        message:
          "No accepted business partners yet. Online donations and ambassador sharing can still move forward.",
      });
    }
    if (missingPayment.length > 0) {
      nudges.push({
        severity: "critical",
        message: `${missingPayment.length} accepted business${missingPayment.length === 1 ? "" : "es"} missing payment/setup info — settlement may be delayed.`,
      });
    }
    if (String(camp.business_timing_status) === "needs_forkup_review") {
      nudges.push({
        severity: "warn",
        message:
          "Business methods need ForkUp review for this short timeline. Online/ambassador paths can continue.",
      });
    }
    if (String(camp.business_timing_status) === "limited_promotion_window") {
      nudges.push({
        severity: "info",
        message:
          "Limited promotion window — Full Success Engine runway is reduced for late acceptances.",
      });
    }

    const { rows: seRows } = await pool.query<QueryResultRow>(
      `SELECT COUNT(*)::int AS n FROM success_engine_actions WHERE campaign_id = $1`,
      [campaignId],
    );
    if (Number(seRows[0]?.n ?? 0) === 0) {
      nudges.push({
        severity: "info",
        message:
          "No Success Engine calendar yet. Generate a campaign operating plan when dates are set.",
      });
    }

    const summary =
      nudges.length === 0
        ? "Campaign health looks stable — no urgent nudges."
        : `${nudges.length} health nudge(s) for this campaign.`;

    await persistInsight({
      campaignId,
      insightType: "health_nudge",
      summary,
      payload: { nudges },
    });

    res.json({
      summary,
      nudges,
      provider: aiProviderName(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load campaign health" });
  }
});

/**
 * POST /api/campaign-ai/:slug/admin-review-summary
 * For campaigns in needs_forkup_review.
 */
campaignAiRouter.post("/:slug/admin-review-summary", async (req, res) => {
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    const camp = await loadCampaignBySlug(slug);
    if (!camp) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(camp.id);
    const methods = await loadCampaignMethods(campaignId);
    const timing = buildTimingGuidance({
      methods,
      startDate: toDateOnlyString(camp.campaign_start_date),
      eventDate: toDateOnlyString(camp.event_date),
      forkupReviewStatus: String(camp.forkup_review_status),
    });

    const facts =
      `Review reason: business giveback/guest bartending with short timeline.\n` +
      `Campaign: ${camp.campaign_name}\nNonprofit: ${camp.organization_name}\n` +
      `Methods: ${describeMethods(methods)}\n` +
      `Timing status: ${timing.timing.status}\nDays until anchor: ${timing.timing.daysUntilAnchor}\n` +
      `ForkUp review status: ${camp.forkup_review_status}\n` +
      `Recommendation baseline: Approve only if business is warm/known and scope is limited; otherwise online/ambassador only or move the date.`;

    const aiExplanation = await polishGuidanceWithAi({
      systemHint:
        "Write an internal ForkUp admin review summary. Final approval stays with a human admin.",
      facts,
    });

    const summary =
      aiExplanation ||
      `Review reason: business method with ${timing.timing.daysUntilAnchor ?? "?"} days lead time. Recommend online/ambassador only or date change unless business is already warm.`;

    await persistInsight({
      campaignId,
      insightType: "admin_review",
      summary,
      payload: { timing: timing.timing, facts },
    });

    // Optional SE action for admin trail
    await pool.query(
      `INSERT INTO success_engine_actions (
         campaign_id, action_type, channel, scheduled_date, title, content,
         status, stakeholder_role, generated_by
       ) VALUES ($1, 'admin_review_summary', 'email', CURRENT_DATE, $2, $3, 'ready', 'admin', $4)`,
      [
        campaignId,
        "Admin review summary",
        summary,
        aiExplanation ? "ai" : "system",
      ],
    );

    res.json({
      summary,
      timing: timing.timing,
      recommendation:
        "Approve only if business is already known/warm and campaign has limited scope. Otherwise recommend online/ambassador only or moving the date.",
      provider: aiProviderName(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build admin review summary" });
  }
});

/**
 * POST /api/campaign-ai/:slug/settlement-narrative
 * Drafts stakeholder settlement messages from settlement totals.
 */
campaignAiRouter.post("/:slug/settlement-narrative", async (req, res) => {
  try {
    const slug = req.params.slug.replace(/\/+$/, "");
    const camp = await loadCampaignBySlug(slug);
    if (!camp) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(camp.id);

    const { rows: settlements } = await pool.query<QueryResultRow>(
      `SELECT COALESCE(SUM(eligible_sales),0) AS eligible_sales,
              COALESCE(SUM(donation_pool),0) AS donation_pool,
              COALESCE(SUM(forkup_fee),0) AS forkup_fee,
              COALESCE(SUM(net_nonprofit_amount),0) AS net_nonprofit_amount
       FROM settlements WHERE campaign_id = $1`,
      [campaignId],
    );
    const s = settlements[0] || {};
    const facts =
      `Campaign: ${camp.campaign_name}\nNonprofit: ${camp.organization_name}\n` +
      `Eligible sales: $${Number(s.eligible_sales ?? 0).toFixed(2)}\n` +
      `Donation pool: $${Number(s.donation_pool ?? 0).toFixed(2)}\n` +
      `ForkUp fee: $${Number(s.forkup_fee ?? 0).toFixed(2)}\n` +
      `Net to nonprofit: $${Number(s.net_nonprofit_amount ?? 0).toFixed(2)}`;

    const aiExplanation = await polishGuidanceWithAi({
      systemHint:
        "Draft clear settlement / impact language for nonprofit and business stakeholders. Be precise with numbers.",
      facts,
    });

    const summary =
      aiExplanation ||
      `Settlement snapshot for ${camp.campaign_name}: donation pool $${Number(s.donation_pool ?? 0).toFixed(2)}, ForkUp fee $${Number(s.forkup_fee ?? 0).toFixed(2)}, net to nonprofit $${Number(s.net_nonprofit_amount ?? 0).toFixed(2)}.`;

    await persistInsight({
      campaignId,
      insightType: "settlement_narrative",
      summary,
      payload: { totals: s },
    });

    res.json({
      summary,
      totals: {
        eligibleSales: Number(s.eligible_sales ?? 0),
        donationPool: Number(s.donation_pool ?? 0),
        forkupFee: Number(s.forkup_fee ?? 0),
        netNonprofitAmount: Number(s.net_nonprofit_amount ?? 0),
      },
      provider: aiProviderName(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build settlement narrative" });
  }
});
