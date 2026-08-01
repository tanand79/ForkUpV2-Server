import { Router } from "express";
import {
  fetchApprovedLibraryItems,
  buildLibraryContext,
  pickFeaturedImage,
  pickPromotionChannels,
  type LibraryOrgType,
} from "../lib/organization-library";
import { aiChat, aiProviderName, parseAiJson } from "../lib/ai-chat";

export const generateCampaignDraftRouter = Router();

/**
 * Parse a whole-dollar fundraising goal from AI output (number or "$5,000" string).
 * Returns null when missing or not a positive finite amount.
 */
function parseSuggestedGoal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const digits = value.replace(/[^0-9.]/g, "");
    if (!digits) return null;
    const n = Number.parseFloat(digits);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }
  return null;
}

/**
 * GoFundMe-style quick-start draft generator.
 *
 * Uses AWS Bedrock when AWS_* credentials are set; otherwise Lovable fallback.
 * Organizer reviews/edits — nothing is auto-published.
 *
 * method: POST /api/generate-campaign-draft
 * request: { purpose, organizationName?, mission?, causeCategory?, goal?, startDate?,
 *            endDate?, methods?, organizationType?, organizationId?, website? }
 * response: { title, story, purpose, suggestedImageUrl, facebookUrl, instagramHandle,
 *             websiteUrl, suggestedGoal?, provider }
 *   suggestedGoal — whole USD amount, only when the organizer did not send a goal.
 */
generateCampaignDraftRouter.post("/generate-campaign-draft", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      purpose?: string;
      organizationName?: string;
      mission?: string;
      causeCategory?: string;
      goal?: number | string;
      startDate?: string;
      endDate?: string;
      methods?: string[];
      organizationType?: string;
      organizationId?: number;
      website?: string;
    };

    const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
    if (!purpose || purpose.length > 2000) {
      res.status(400).json({ error: "Tell us what you're raising money for." });
      return;
    }

    if (aiProviderName() === "none") {
      res.status(503).json({
        error:
          "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
      });
      return;
    }

    const organizationName =
      typeof body.organizationName === "string" ? body.organizationName.trim() : "";
    const mission = typeof body.mission === "string" ? body.mission.trim() : "";
    const causeCategory =
      typeof body.causeCategory === "string" ? body.causeCategory.trim() : "";
    const website = typeof body.website === "string" ? body.website.trim() : "";
    const goal =
      body.goal != null && String(body.goal).trim() !== "" ? String(body.goal).trim() : "";
    const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    const methods = Array.isArray(body.methods)
      ? body.methods.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
      : [];
    const needsSuggestedGoal = !goal;

    let libraryContext = "";
    let suggestedImageUrl: string | null = null;
    let libraryPromotion = { facebookUrl: "", instagramHandle: "", websiteUrl: "" };
    const orgType = body.organizationType === "business" ? "business" : "nonprofit";
    const orgId = Number(body.organizationId);
    if (orgId) {
      const approved = await fetchApprovedLibraryItems(orgType as LibraryOrgType, orgId);
      libraryContext = buildLibraryContext(approved);
      suggestedImageUrl = pickFeaturedImage(approved);
      libraryPromotion = pickPromotionChannels(approved);
    }

    const system = [
      "You are an expert nonprofit fundraising campaign writer for the ForkUp platform.",
      "Given a few short answers from a nonprofit organizer, prepare a campaign draft they will review and edit.",
      "Write in the organization's authentic voice. Be specific and truthful to what was shared — never invent facts, names, dates, or past results.",
      "Prioritize emotional connection, clarity, impact, and a clear reason to participate.",
      "Guidelines:",
      "- title: a compelling campaign title, max ~70 characters, no quotation marks.",
      "- story: 120-220 words, warm and concrete, explaining why the cause matters and how support helps. No generic clichés or invented statistics.",
      "- purpose: a single short sentence summarizing the campaign goal.",
      "- facebookUrl: public Facebook page URL if you know the real one for this org; otherwise empty string. Never invent.",
      "- instagramHandle: public Instagram handle like @orgname if you know the real one; otherwise empty string. Never invent.",
      "- websiteUrl: official organization website URL if known from context; otherwise empty string.",
      needsSuggestedGoal
        ? "- suggestedGoal: a realistic whole-dollar USD fundraising target (integer, no $ or commas) based on purpose, methods, and campaign length. Typical community campaigns: 2500–25000. This is a recommendation the organizer can edit — not a claimed past result. Do not put the dollar amount in the story as a fact."
        : "- Do not invent a fundraising goal amount; the organizer already provided one.",
      needsSuggestedGoal
        ? 'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string, "facebookUrl": string, "instagramHandle": string, "websiteUrl": string, "suggestedGoal": number}.'
        : 'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string, "facebookUrl": string, "instagramHandle": string, "websiteUrl": string}.',
      "Do not include markdown, code fences, preamble, or commentary.",
    ].join("\n");

    const userParts = [
      `What they're raising money for: ${purpose}`,
      organizationName ? `Organization: ${organizationName}` : "",
      mission ? `Mission: ${mission}` : "",
      causeCategory ? `Cause category: ${causeCategory}` : "",
      website ? `Organization website: ${website}` : "",
      goal ? `Fundraising goal: ${goal}` : "Fundraising goal: not provided — suggest a realistic target.",
      startDate || endDate ? `Dates: ${startDate || "TBD"} to ${endDate || "TBD"}` : "",
      methods.length ? `Fundraising methods: ${methods.join(", ")}` : "",
      libraryContext,
    ].filter(Boolean);

    const raw = await aiChat({
      system,
      user: userParts.join("\n"),
      json: true,
      maxTokens: 2048,
      temperature: 0.4,
    });

    let draft: {
      title?: string;
      story?: string;
      purpose?: string;
      facebookUrl?: string;
      instagramHandle?: string;
      websiteUrl?: string;
      suggestedGoal?: number | string;
    } = {};
    try {
      draft = parseAiJson(raw);
    } catch {
      draft = { story: raw };
    }

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const suggestedGoal = needsSuggestedGoal ? parseSuggestedGoal(draft.suggestedGoal) : null;

    res.json({
      title: str(draft.title),
      story: str(draft.story),
      purpose: str(draft.purpose),
      suggestedImageUrl,
      facebookUrl: libraryPromotion.facebookUrl || str(draft.facebookUrl),
      instagramHandle: libraryPromotion.instagramHandle || str(draft.instagramHandle),
      websiteUrl: libraryPromotion.websiteUrl || str(draft.websiteUrl) || website,
      ...(suggestedGoal != null ? { suggestedGoal } : {}),
      provider: aiProviderName(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not prepare the campaign draft.";
    res.status(400).json({ error: message });
  }
});
