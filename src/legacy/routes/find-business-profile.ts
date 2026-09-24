/**
 * Pass D1 — find business profile from name (restaurant / local Join Us).
 *
 * POST /api/find-business-profile
 * request: { businessName, joinDoorType?, nearZip?, city?, state? }
 * response: FindBusinessFromNameResult (see find-business-from-name.ts)
 *
 * Changelog (D1): Added — additive endpoint; does not change generate-business-draft.
 * Changelog: Optional nearZip/city/state for nearby store + social URLs on result.
 * Changelog: Optional website — use known DB/site URL so social scrape hits the right host
 *            (e.g. The Pear → thepeardilworthtown.com, not an AI-guessed wrong domain).
 */
import { Router } from "express";
import { findBusinessFromName } from "../lib/find-business-from-name";

export const findBusinessProfileRouter = Router();

findBusinessProfileRouter.post("/find-business-profile", async (req, res) => {
  try {
    const businessName =
      typeof req.body?.businessName === "string" ? req.body.businessName.trim() : "";
    if (!businessName) {
      res.status(400).json({ error: "Business name is required." });
      return;
    }
    const result = await findBusinessFromName({
      businessName,
      joinDoorType: req.body?.joinDoorType,
      nearZip: req.body?.nearZip,
      city: req.body?.city,
      state: req.body?.state,
      website: req.body?.website,
      businessId: req.body?.businessId,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to find business profile";
    const status =
      message.toLowerCase().includes("rate")
        ? 429
        : message.toLowerCase().includes("no ai provider")
          ? 503
          : 500;
    res.status(status).json({ error: message });
  }
});
