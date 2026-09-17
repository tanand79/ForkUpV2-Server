/**
 * Pass D1 — find business profile from name (restaurant / local Join Us).
 *
 * POST /api/find-business-profile
 * request: { businessName: string, joinDoorType?: "restaurant" | "local" }
 * response: FindBusinessFromNameResult (see find-business-from-name.ts)
 *
 * Changelog (D1): Added — additive endpoint; does not change generate-business-draft.
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
