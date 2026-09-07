import { Router } from "express";
import { generateBusinessDraftFromWebsite } from "../lib/business-draft-from-website";

export const generateBusinessDraftRouter = Router();

/**
 * POST /api/generate-business-draft
 * request: { website: string }
 * response: BusinessDraftFromWebsite (see business-draft-from-website.ts)
 */
generateBusinessDraftRouter.post("/generate-business-draft", async (req, res) => {
  try {
    const website = typeof req.body?.website === "string" ? req.body.website.trim() : "";
    if (!website) {
      res.status(400).json({ error: "Website URL is required." });
      return;
    }
    const draft = await generateBusinessDraftFromWebsite(website);
    res.json(draft);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to generate business draft";
    const status =
      message.toLowerCase().includes("rate") ? 429 :
      message.toLowerCase().includes("no ai provider") ? 503 :
      500;
    res.status(status).json({ error: message });
  }
});
