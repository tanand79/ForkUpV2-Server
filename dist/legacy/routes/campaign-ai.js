"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.campaignAiRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const date_only_1 = require("../lib/date-only");
const campaign_ai_guidance_1 = require("../lib/campaign-ai-guidance");
const success_engine_calendar_1 = require("../lib/success-engine-calendar");
const ai_chat_1 = require("../lib/ai-chat");
exports.campaignAiRouter = (0, express_1.Router)();
async function loadCampaignBySlug(slug) {
    const { rows } = await pool_1.pool.query(`SELECT c.id, c.slug, c.campaign_name, c.campaign_story, c.campaign_goal,
            c.campaign_start_date, c.campaign_end_date, c.event_date,
            c.cover_image_url, c.business_timing_status, c.forkup_review_status,
            n.organization_name, n.id AS nonprofit_id
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.slug = $1`, [slug]);
    return rows[0] ?? null;
}
async function loadCampaignMethods(campaignId) {
    const { rows } = await pool_1.pool.query(`SELECT method_type FROM campaign_methods WHERE campaign_id = $1`, [campaignId]);
    return rows.map((r) => r.method_type);
}
async function persistInsight(input) {
    await pool_1.pool.query(`INSERT INTO campaign_ai_insights (campaign_id, insight_type, score, summary, payload_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)`, [
        input.campaignId,
        input.insightType,
        input.score ?? null,
        input.summary,
        JSON.stringify(input.payload),
    ]);
}
exports.campaignAiRouter.post("/timing-guidance", async (req, res) => {
    try {
        const body = req.body;
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
            startDate = startDate || (0, date_only_1.toDateOnlyString)(camp.campaign_start_date) || undefined;
            eventDate = eventDate || (0, date_only_1.toDateOnlyString)(camp.event_date) || undefined;
            forkupReviewStatus =
                forkupReviewStatus || String(camp.forkup_review_status || "none");
        }
        const result = (0, campaign_ai_guidance_1.buildTimingGuidance)({
            methods,
            startDate,
            eventDate,
            forkupReviewStatus,
        });
        const aiExplanation = await (0, campaign_ai_guidance_1.polishGuidanceWithAi)({
            systemHint: "Explain this campaign timing assessment to a nonprofit organizer.",
            facts: `${result.summary}\nMethods: ${(0, campaign_ai_guidance_1.describeMethods)(methods)}\nStatus: ${result.timing.status}\nDays: ${result.timing.daysUntilAnchor}\nMessage: ${result.timing.message ?? ""}`,
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to build timing guidance" });
    }
});
exports.campaignAiRouter.post("/method-mix", async (req, res) => {
    try {
        const body = req.body;
        const result = (0, campaign_ai_guidance_1.recommendMethodMix)({
            methods: body.methods,
            startDate: body.startDate,
            eventDate: body.eventDate,
            endDate: body.endDate,
            goal: body.goal,
        });
        result.aiExplanation = await (0, campaign_ai_guidance_1.polishGuidanceWithAi)({
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to recommend method mix" });
    }
});
exports.campaignAiRouter.post("/invite-readiness", async (req, res) => {
    try {
        const body = req.body;
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
            const { rows: partnerRows } = await pool_1.pool.query(`SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE LOWER(COALESCE(b.contact_email,'')) LIKE '%@%')::int AS with_email
         FROM campaign_business_locations cbl
         JOIN businesses b ON b.id = cbl.business_id
         WHERE cbl.campaign_id = $1`, [campaignId]);
            body.invitedBusinessCount = Number(partnerRows[0]?.n ?? 0);
            body.hasBusinessContacts = Number(partnerRows[0]?.with_email ?? 0) > 0;
            body.hasStory = Boolean(String(camp.campaign_story || "").trim());
            body.hasCover = Boolean(String(camp.cover_image_url || "").trim());
            body.hasNonprofitProfile = true;
            body.startDate =
                body.startDate || (0, date_only_1.toDateOnlyString)(camp.campaign_start_date) || undefined;
            body.endDate =
                body.endDate || (0, date_only_1.toDateOnlyString)(camp.campaign_end_date) || undefined;
            body.eventDate =
                body.eventDate || (0, date_only_1.toDateOnlyString)(camp.event_date) || undefined;
        }
        const result = (0, campaign_ai_guidance_1.scoreInviteReadiness)({
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
        result.aiExplanation = await (0, campaign_ai_guidance_1.polishGuidanceWithAi)({
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to score invite readiness" });
    }
});
exports.campaignAiRouter.post("/generate-calendar", async (req, res) => {
    try {
        const body = req.body;
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
        const { rows: accepted } = await pool_1.pool.query(`SELECT id FROM campaign_business_locations
       WHERE campaign_id = $1 AND acceptance_status IN ('accepted', 'ready', 'live', 'completed')
       LIMIT 1`, [campaignId]);
        const drafts = (0, success_engine_calendar_1.buildSuccessEngineCalendar)({
            campaignName: String(camp.campaign_name),
            methods,
            startDate: (0, date_only_1.toDateOnlyString)(camp.campaign_start_date),
            eventDate: (0, date_only_1.toDateOnlyString)(camp.event_date),
            endDate: (0, date_only_1.toDateOnlyString)(camp.campaign_end_date),
            nonprofitName: String(camp.organization_name),
            hasAcceptedBusiness: accepted.length > 0,
        });
        let created = 0;
        for (const draft of drafts) {
            const { rows: existing } = await pool_1.pool.query(`SELECT id FROM success_engine_actions
         WHERE campaign_id = $1 AND action_type = $2 AND scheduled_date = $3
         LIMIT 1`, [campaignId, draft.action_type, draft.scheduled_date]);
            if (existing.length > 0)
                continue;
            await pool_1.pool.query(`INSERT INTO success_engine_actions (
           campaign_id, action_type, channel, scheduled_date, title, content,
           status, stakeholder_role, generated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)`, [
                campaignId,
                draft.action_type,
                draft.channel,
                draft.scheduled_date,
                draft.title,
                draft.content,
                draft.stakeholder_role,
                draft.generated_by,
            ]);
            created += 1;
        }
        const summary = `Generated Success Engine calendar: ${created} new action(s) for "${camp.campaign_name}".`;
        await persistInsight({
            campaignId,
            insightType: "calendar_plan",
            summary,
            payload: { created, totalDrafts: drafts.length, provider: (0, ai_chat_1.aiProviderName)() },
        });
        res.json({
            success: true,
            created,
            totalDrafts: drafts.length,
            actions: drafts,
            provider: (0, ai_chat_1.aiProviderName)(),
            message: summary,
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to generate Success Engine calendar" });
    }
});
exports.campaignAiRouter.get("/:slug/health", async (req, res) => {
    try {
        const slug = req.params.slug.replace(/\/+$/, "");
        const camp = await loadCampaignBySlug(slug);
        if (!camp) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(camp.id);
        const nudges = [];
        const { rows: partners } = await pool_1.pool.query(`SELECT acceptance_status, setup_status, settlement_ready_status, respond_by_date
       FROM campaign_business_locations WHERE campaign_id = $1`, [campaignId]);
        const pending = partners.filter((p) => ["invited", "pending", "opened"].includes(String(p.acceptance_status)));
        const accepted = partners.filter((p) => ["accepted", "ready", "live", "completed"].includes(String(p.acceptance_status)));
        const missingPayment = accepted.filter((p) => String(p.settlement_ready_status) === "needs_info");
        if (pending.length > 0) {
            nudges.push({
                severity: "warn",
                message: `${pending.length} business${pending.length === 1 ? " has" : "es have"} not responded yet. Send a reminder before the respond-by date.`,
            });
        }
        if (partners.length > 0 && accepted.length === 0) {
            nudges.push({
                severity: "info",
                message: "No accepted business partners yet. Online donations and ambassador sharing can still move forward.",
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
                message: "Business methods need ForkUp review for this short timeline. Online/ambassador paths can continue.",
            });
        }
        if (String(camp.business_timing_status) === "limited_promotion_window") {
            nudges.push({
                severity: "info",
                message: "Limited promotion window — Full Success Engine runway is reduced for late acceptances.",
            });
        }
        if (String(camp.business_timing_status) === "tight_timeline") {
            nudges.push({
                severity: "warn",
                message: "Tight timeline (8–20 days): confirm an existing business agreement, submit for ForkUp review, or switch to Online Donation / Ambassador Sharing.",
            });
        }
        if (String(camp.business_timing_status) === "too_soon") {
            nudges.push({
                severity: "critical",
                message: "Too soon (0–7 days) for a new business-based campaign. Change the date or continue with Online Donation / Ambassador Sharing only.",
            });
        }
        const { rows: seRows } = await pool_1.pool.query(`SELECT COUNT(*)::int AS n FROM success_engine_actions WHERE campaign_id = $1`, [campaignId]);
        if (Number(seRows[0]?.n ?? 0) === 0) {
            nudges.push({
                severity: "info",
                message: "No Success Engine calendar yet. Generate a campaign operating plan when dates are set.",
            });
        }
        const summary = nudges.length === 0
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
            provider: (0, ai_chat_1.aiProviderName)(),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load campaign health" });
    }
});
exports.campaignAiRouter.post("/:slug/admin-review-summary", async (req, res) => {
    try {
        const slug = req.params.slug.replace(/\/+$/, "");
        const camp = await loadCampaignBySlug(slug);
        if (!camp) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(camp.id);
        const methods = await loadCampaignMethods(campaignId);
        const timing = (0, campaign_ai_guidance_1.buildTimingGuidance)({
            methods,
            startDate: (0, date_only_1.toDateOnlyString)(camp.campaign_start_date),
            eventDate: (0, date_only_1.toDateOnlyString)(camp.event_date),
            forkupReviewStatus: String(camp.forkup_review_status),
        });
        const facts = `Review reason: business giveback/guest bartending with short timeline.\n` +
            `Campaign: ${camp.campaign_name}\nNonprofit: ${camp.organization_name}\n` +
            `Methods: ${(0, campaign_ai_guidance_1.describeMethods)(methods)}\n` +
            `Timing status: ${timing.timing.status}\nDays until anchor: ${timing.timing.daysUntilAnchor}\n` +
            `ForkUp review status: ${camp.forkup_review_status}\n` +
            `Recommendation baseline: Approve only if business is warm/known and scope is limited; otherwise online/ambassador only or move the date.`;
        const aiExplanation = await (0, campaign_ai_guidance_1.polishGuidanceWithAi)({
            systemHint: "Write an internal ForkUp admin review summary. Final approval stays with a human admin.",
            facts,
        });
        const summary = aiExplanation ||
            `Review reason: business method with ${timing.timing.daysUntilAnchor ?? "?"} days lead time. Recommend online/ambassador only or date change unless business is already warm.`;
        await persistInsight({
            campaignId,
            insightType: "admin_review",
            summary,
            payload: { timing: timing.timing, facts },
        });
        await pool_1.pool.query(`INSERT INTO success_engine_actions (
         campaign_id, action_type, channel, scheduled_date, title, content,
         status, stakeholder_role, generated_by
       ) VALUES ($1, 'admin_review_summary', 'email', CURRENT_DATE, $2, $3, 'ready', 'admin', $4)`, [
            campaignId,
            "Admin review summary",
            summary,
            aiExplanation ? "ai" : "system",
        ]);
        res.json({
            summary,
            timing: timing.timing,
            recommendation: "Approve only if business is already known/warm and campaign has limited scope. Otherwise recommend online/ambassador only or moving the date.",
            provider: (0, ai_chat_1.aiProviderName)(),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to build admin review summary" });
    }
});
exports.campaignAiRouter.post("/:slug/settlement-narrative", async (req, res) => {
    try {
        const slug = req.params.slug.replace(/\/+$/, "");
        const camp = await loadCampaignBySlug(slug);
        if (!camp) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const campaignId = Number(camp.id);
        const { rows: settlements } = await pool_1.pool.query(`SELECT COALESCE(SUM(eligible_sales),0) AS eligible_sales,
              COALESCE(SUM(donation_pool),0) AS donation_pool,
              COALESCE(SUM(forkup_fee),0) AS forkup_fee,
              COALESCE(SUM(net_nonprofit_amount),0) AS net_nonprofit_amount
       FROM settlements WHERE campaign_id = $1`, [campaignId]);
        const s = settlements[0] || {};
        const facts = `Campaign: ${camp.campaign_name}\nNonprofit: ${camp.organization_name}\n` +
            `Eligible sales: $${Number(s.eligible_sales ?? 0).toFixed(2)}\n` +
            `Donation pool: $${Number(s.donation_pool ?? 0).toFixed(2)}\n` +
            `ForkUp fee: $${Number(s.forkup_fee ?? 0).toFixed(2)}\n` +
            `Net to nonprofit: $${Number(s.net_nonprofit_amount ?? 0).toFixed(2)}`;
        const aiExplanation = await (0, campaign_ai_guidance_1.polishGuidanceWithAi)({
            systemHint: "Draft clear settlement / impact language for nonprofit and business stakeholders. Be precise with numbers.",
            facts,
        });
        const summary = aiExplanation ||
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
            provider: (0, ai_chat_1.aiProviderName)(),
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to build settlement narrative" });
    }
});
//# sourceMappingURL=campaign-ai.js.map