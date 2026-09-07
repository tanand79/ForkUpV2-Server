/**
 * User-facing AI engine settings (Dermwrite-style — not Super Admin only).
 *
 * GET  /api/ai/models
 *   response: { models: [{ id, label, vendor, tier, blurb, inputPer1M, outputPer1M }] }
 *
 * GET  /api/ai/settings
 *   response: { modelId } — user preference when signed in, else platform default
 *
 * PUT  /api/ai/settings
 *   body: { modelId: string }
 *   response: { modelId }
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { BEDROCK_MODEL_CATALOG, migrateBedrockModelId } from "../lib/bedrock-model-catalog";
import { getPlatformSetting } from "../lib/platform-settings";
import {
  getUserAiBedrockModel,
  setUserAiBedrockModel,
} from "../lib/user-ai-settings";

export const aiRouter = Router();

aiRouter.get("/models", (_req, res) => {
  res.json({ models: BEDROCK_MODEL_CATALOG });
});

aiRouter.get("/settings", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    const platformDefault = migrateBedrockModelId(
      (await getPlatformSetting("ai_model_id")) ||
        process.env.BEDROCK_MODEL_ID?.trim() ||
        undefined,
    );
    if (!user) {
      res.json({ modelId: platformDefault });
      return;
    }
    const userModel = await getUserAiBedrockModel(user.id);
    res.json({ modelId: userModel ?? platformDefault });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load AI settings" });
  }
});

aiRouter.put("/settings", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in to save your AI engine preference" });
      return;
    }
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
    if (!modelId) {
      res.status(400).json({ error: "modelId is required" });
      return;
    }
    const saved = await setUserAiBedrockModel(user.id, modelId);
    res.json({ modelId: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save AI settings";
    res.status(400).json({ error: message });
  }
});
