/**
 * AI-first create flow API (backend Steps 3–4 + Step 5 ideas).
 *
 * Auth: optional Bearer token (stores created_by_user_id when present).
 * Guest callers are allowed — no login required.
 *
 * POST /api/ai-campaign-flow/analyze
 *   request: {
 *     organizationName: string,
 *     ein?, nonprofitId?, website?, facebookUrl?, instagramUrl?, linkedinUrl?,
 *     mission?, causeCategory?, city?, state?
 *   }
 *   response: AnalysisSessionRecord (status completed + ideas[])
 *
 * POST /api/ai-campaign-flow/resolve-sources
 *   request: same identity fields as analyze (no full scrape/ideas)
 *   response: { organizationName, ein, nonprofitId, website, facebookUrl,
 *     instagramUrl, linkedinUrl, mission, causeCategory, city, state }
 *
 * GET /api/ai-campaign-flow/sessions/:sessionToken
 *   response: AnalysisSessionRecord | 404
 *
 * POST /api/ai-campaign-flow/draft-from-purpose
 *   request: { purpose, organizationName?, mission?, causeCategory?, website?, methods?, goal? }
 *   response: { title, story, purpose, suggestedGoal?, provider }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  draftCampaignFromPurpose,
  getAnalysisSessionByToken,
  resolveAnalysisSources,
  runOrganizationAiCampaignFlow,
} from "../lib/organization-ai-campaign-flow";

export const aiCampaignFlowRouter = Router();

function trimBodyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * method: POST /api/ai-campaign-flow/analyze
 * Runs compulsory website/social analysis + idea generation (no dedicated UI).
 */
aiCampaignFlowRouter.post("/analyze", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const organizationName = trimBodyString(body.organizationName);
    if (!organizationName || organizationName.length > 255) {
      res.status(400).json({ error: "organizationName is required." });
      return;
    }

    const auth = await resolveAuthUser(bearerToken(req));
    const nonprofitIdRaw = body.nonprofitId;
    const nonprofitId =
      typeof nonprofitIdRaw === "number"
        ? nonprofitIdRaw
        : typeof nonprofitIdRaw === "string" && nonprofitIdRaw.trim()
          ? Number(nonprofitIdRaw)
          : null;

    const session = await runOrganizationAiCampaignFlow({
      organizationName,
      ein: trimBodyString(body.ein) || null,
      nonprofitId: Number.isFinite(nonprofitId as number) ? (nonprofitId as number) : null,
      website: trimBodyString(body.website) || null,
      facebookUrl: trimBodyString(body.facebookUrl) || null,
      instagramUrl: trimBodyString(body.instagramUrl) || null,
      linkedinUrl: trimBodyString(body.linkedinUrl) || null,
      mission: trimBodyString(body.mission) || null,
      causeCategory: trimBodyString(body.causeCategory) || null,
      city: trimBodyString(body.city) || null,
      state: trimBodyString(body.state) || null,
      createdByUserId: auth?.id ?? null,
    });

    res.json(session);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not analyze organization for campaign ideas.";
    const status = /No AI provider configured/i.test(message) ? 503 : 400;
    res.status(status).json({ error: message });
  }
});

/**
 * method: POST /api/ai-campaign-flow/resolve-sources
 * Purpose: Prefill Connect Social fields without running full analyze/ideas.
 * request: { organizationName, ein?, nonprofitId?, website?, facebookUrl?,
 *   instagramUrl?, linkedinUrl?, mission?, causeCategory?, city?, state? }
 * response: resolved website + social URLs from nonprofit row / known profile / AI guess
 */
aiCampaignFlowRouter.post("/resolve-sources", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const organizationName = trimBodyString(body.organizationName);
    if (!organizationName || organizationName.length > 255) {
      res.status(400).json({ error: "organizationName is required." });
      return;
    }

    const nonprofitIdRaw = body.nonprofitId;
    const nonprofitId =
      typeof nonprofitIdRaw === "number"
        ? nonprofitIdRaw
        : typeof nonprofitIdRaw === "string" && nonprofitIdRaw.trim()
          ? Number(nonprofitIdRaw)
          : null;

    const sources = await resolveAnalysisSources({
      organizationName,
      ein: trimBodyString(body.ein) || null,
      nonprofitId: Number.isFinite(nonprofitId as number) ? (nonprofitId as number) : null,
      website: trimBodyString(body.website) || null,
      facebookUrl: trimBodyString(body.facebookUrl) || null,
      instagramUrl: trimBodyString(body.instagramUrl) || null,
      linkedinUrl: trimBodyString(body.linkedinUrl) || null,
      mission: trimBodyString(body.mission) || null,
      causeCategory: trimBodyString(body.causeCategory) || null,
      city: trimBodyString(body.city) || null,
      state: trimBodyString(body.state) || null,
    });

    res.json(sources);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not resolve organization links.";
    res.status(400).json({ error: message });
  }
});

/**
 * method: GET /api/ai-campaign-flow/sessions/:sessionToken
 * Resume Step 5 idea picker from a prior analyze call.
 */
aiCampaignFlowRouter.get("/sessions/:sessionToken", async (req, res) => {
  try {
    const sessionToken = trimBodyString(req.params.sessionToken);
    if (!sessionToken || sessionToken.length > 128) {
      res.status(400).json({ error: "sessionToken is required." });
      return;
    }

    const session = await getAnalysisSessionByToken(sessionToken);
    if (!session) {
      res.status(404).json({ error: "Analysis session not found or expired." });
      return;
    }

    res.json(session);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load analysis session." });
  }
});

/**
 * method: POST /api/ai-campaign-flow/draft-from-purpose
 * Purpose: Scratch-path title + story from a short purpose phrase (new AI stack).
 * request: { purpose, organizationName?, mission?, causeCategory?, website?, methods?, goal? }
 * response: { title, story, purpose, suggestedGoal?, provider }
 */
aiCampaignFlowRouter.post("/draft-from-purpose", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purpose = trimBodyString(body.purpose);
    if (!purpose || purpose.length > 2000) {
      res.status(400).json({ error: "Tell us what you're raising money for." });
      return;
    }

    const methods = Array.isArray(body.methods)
      ? body.methods.filter((m): m is string => typeof m === "string" && !!m.trim())
      : undefined;

    const draft = await draftCampaignFromPurpose({
      purpose,
      organizationName: trimBodyString(body.organizationName) || "Your organization",
      mission: trimBodyString(body.mission) || null,
      causeCategory: trimBodyString(body.causeCategory) || null,
      website: trimBodyString(body.website) || null,
      methods,
      goal:
        body.goal != null && String(body.goal).trim() !== ""
          ? (body.goal as string | number)
          : null,
    });

    res.json({
      title: draft.title,
      story: draft.story,
      purpose: draft.purpose,
      ...(draft.suggestedGoal != null ? { suggestedGoal: draft.suggestedGoal } : {}),
      provider: draft.provider,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not prepare the campaign draft.";
    const status = /No AI provider configured/i.test(message) ? 503 : 400;
    res.status(status).json({ error: message });
  }
});
