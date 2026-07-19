import { Router } from "express";
import {
  fetchApprovedLibraryItems,
  buildLibraryContext,
  pickFeaturedImage,
  type LibraryOrgType,
} from "../lib/organization-library";

export const generateCampaignDraftRouter = Router();

/**
 * GoFundMe-style quick-start draft generator.
 *
 * Takes the handful of answers the organizer provides in the simplified
 * builder (what they're raising for, goal, dates, chosen methods) plus the
 * active organization's name/mission, and asks the Lovable AI gateway to
 * prepare a campaign title, story, and one-line purpose. The organizer then
 * reviews/edits — nothing is auto-published.
 *
 * Mirrors the pattern in improve-story.ts (same gateway + error handling).
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
    };

    const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
    if (!purpose || purpose.length > 2000) {
      res.status(400).json({ error: "Tell us what you're raising money for." });
      return;
    }

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "Missing LOVABLE_API_KEY" });
      return;
    }

    const organizationName =
      typeof body.organizationName === "string" ? body.organizationName.trim() : "";
    const mission = typeof body.mission === "string" ? body.mission.trim() : "";
    const causeCategory =
      typeof body.causeCategory === "string" ? body.causeCategory.trim() : "";
    const goal =
      body.goal != null && String(body.goal).trim() !== "" ? String(body.goal).trim() : "";
    const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    const methods = Array.isArray(body.methods)
      ? body.methods.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
      : [];

    // Entity-specific AI: enrich the prompt with the organization's approved
    // library content when we know which organization this draft is for.
    let libraryContext = "";
    let suggestedImageUrl: string | null = null;
    const orgType = body.organizationType === "business" ? "business" : "nonprofit";
    const orgId = Number(body.organizationId);
    if (orgId) {
      const approved = await fetchApprovedLibraryItems(orgType as LibraryOrgType, orgId);
      libraryContext = buildLibraryContext(approved);
      suggestedImageUrl = pickFeaturedImage(approved);
    }

    const system = [
      "You are an expert nonprofit fundraising campaign writer for the ForkUp platform.",
      "Given a few short answers from a nonprofit organizer, prepare a campaign draft they will review and edit.",
      "Write in the organization's authentic voice. Be specific and truthful to what was shared — never invent facts, figures, names, dates, or results.",
      "Prioritize emotional connection, clarity, impact, and a clear reason to participate.",
      "Guidelines:",
      "- title: a compelling campaign title, max ~70 characters, no quotation marks.",
      "- story: 120-220 words, warm and concrete, explaining why the cause matters and how support helps. No generic clichés or invented statistics.",
      "- purpose: a single short sentence summarizing the campaign goal.",
      'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string}.',
      "Do not include markdown, code fences, preamble, or commentary.",
    ].join("\n");

    const userParts = [
      `What they're raising money for: ${purpose}`,
      organizationName ? `Organization: ${organizationName}` : "",
      mission ? `Mission: ${mission}` : "",
      causeCategory ? `Cause category: ${causeCategory}` : "",
      goal ? `Fundraising goal: ${goal}` : "",
      startDate || endDate ? `Dates: ${startDate || "TBD"} to ${endDate || "TBD"}` : "",
      methods.length ? `Fundraising methods: ${methods.join(", ")}` : "",
      libraryContext,
    ].filter(Boolean);

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userParts.join("\n") },
        ],
      }),
    });

    if (upstream.status === 429) {
      res.status(429).json({ error: "Rate limited. Please try again in a moment." });
      return;
    }
    if (upstream.status === 402) {
      res.status(402).json({ error: "AI credits exhausted. Please add credits to continue." });
      return;
    }
    if (!upstream.ok) {
      res.status(502).json({ error: "Could not prepare the draft. Please try again." });
      return;
    }

    const json = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!raw) {
      res.status(502).json({ error: "Could not prepare the draft. Please try again." });
      return;
    }

    // Strip accidental code fences before parsing.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let draft: { title?: string; story?: string; purpose?: string } = {};
    try {
      draft = JSON.parse(cleaned) as { title?: string; story?: string; purpose?: string };
    } catch {
      // Fall back to using the raw text as the story if JSON parsing fails.
      draft = { story: cleaned };
    }

    res.json({
      title: typeof draft.title === "string" ? draft.title.trim() : "",
      story: typeof draft.story === "string" ? draft.story.trim() : "",
      purpose: typeof draft.purpose === "string" ? draft.purpose.trim() : "",
      suggestedImageUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not prepare the campaign draft.";
    res.status(400).json({ error: message });
  }
});
