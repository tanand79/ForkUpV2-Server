/**
 * Suggest nearby restaurants / local businesses from a US ZIP (AI).
 *
 * POST /api/suggest-nearby-businesses
 * request: { nearZip, joinDoorType?, city?, state?, limit? }
 * response: SuggestNearbyBusinessesResult
 *
 * Additive — does not change find-business-profile.
 */
import { Router } from "express";
import { suggestNearbyBusinesses } from "../lib/suggest-nearby-businesses";

export const suggestNearbyBusinessesRouter = Router();

suggestNearbyBusinessesRouter.post(
  "/suggest-nearby-businesses",
  async (req, res) => {
    try {
      const nearZip =
        typeof req.body?.nearZip === "string"
          ? req.body.nearZip
          : typeof req.body?.zip === "string"
            ? req.body.zip
            : "";
      const result = await suggestNearbyBusinesses({
        nearZip,
        joinDoorType: req.body?.joinDoorType,
        city: req.body?.city,
        state: req.body?.state,
        limit: req.body?.limit,
      });
      res.json(result);
    } catch (err) {
      console.error(err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to suggest nearby businesses";
      const status =
        message.toLowerCase().includes("zip is required") ||
        message.toLowerCase().includes("5-digit")
          ? 400
          : message.toLowerCase().includes("rate")
            ? 429
            : message.toLowerCase().includes("no ai provider")
              ? 503
              : 500;
      res.status(status).json({ error: message });
    }
  },
);
