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
 * GET /api/ai-campaign-flow/sessions/:sessionToken
 *   response: AnalysisSessionRecord | 404
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  getAnalysisSessionByToken,
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
