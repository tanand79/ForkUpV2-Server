/**
 * HTTP routes for campaign partner join requests (business → NPO).
 *
 * Mounted under:
 * - /api/business — create + list mine
 * - /api/manage — list for NPO + accept + decline
 *
 * Additive only — does not change existing invite accept paths.
 */
import { Router } from "express";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  acceptPartnerJoinRequest,
  createPartnerJoinRequest,
  declinePartnerJoinRequest,
  listMyPartnerJoinRequests,
  listPartnerJoinRequestsForCampaign,
  userMayManageCampaignNonprofit,
} from "../lib/campaign-partner-join-requests";
import { pool } from "../db/pool";
import type { MethodType } from "../types/campaign";
import type { QueryResultRow } from "pg";

export const campaignPartnerJoinBusinessRouter = Router();
export const campaignPartnerJoinManageRouter = Router();

/**
 * POST /api/business/campaigns/:slug/partner-join-requests
 * Body: { businessId, locationId?, methodType?, doorType?, message?, proposedGivebackPercentage? }
 */
campaignPartnerJoinBusinessRouter.post(
  "/campaigns/:slug/partner-join-requests",
  async (req, res) => {
    try {
      const authUser = await resolveAuthUser(bearerToken(req));
      if (!authUser) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const body = req.body as {
        businessId?: number;
        locationId?: number;
        methodType?: MethodType;
        doorType?: "restaurant" | "local";
        message?: string;
        proposedGivebackPercentage?: number;
      };
      const businessId = Number(body.businessId);
      if (!businessId) {
        res.status(400).json({ error: "businessId is required" });
        return;
      }

      const result = await createPartnerJoinRequest({
        slug: String(req.params.slug ?? ""),
        user: authUser,
        businessId,
        locationId: body.locationId != null ? Number(body.locationId) : undefined,
        methodType: body.methodType,
        doorType: body.doorType,
        message: body.message,
        proposedGivebackPercentage: body.proposedGivebackPercentage,
      });

      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.request ? { request: result.request } : {}),
        });
        return;
      }
      res.status(201).json({ request: result.request });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create partner join request" });
    }
  },
);

/**
 * GET /api/business/campaigns/:slug/partner-join-requests/mine?businessId=
 */
campaignPartnerJoinBusinessRouter.get(
  "/campaigns/:slug/partner-join-requests/mine",
  async (req, res) => {
    try {
      const authUser = await resolveAuthUser(bearerToken(req));
      if (!authUser) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const businessId = Number(req.query.businessId);
      if (!businessId) {
        res.status(400).json({ error: "businessId query param is required" });
        return;
      }
      const result = await listMyPartnerJoinRequests({
        slug: String(req.params.slug ?? ""),
        user: authUser,
        businessId,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ requests: result.requests });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to list partner join requests" });
    }
  },
);

/**
 * GET /api/manage/campaigns/:slug/partner-join-requests?status=pending|accepted|declined|all
 */
campaignPartnerJoinManageRouter.get(
  "/campaigns/:slug/partner-join-requests",
  async (req, res) => {
    try {
      const authUser = await resolveAuthUser(bearerToken(req));
      if (!authUser) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const slug = String(req.params.slug ?? "").replace(/\/+$/, "");
      const { rows: campaigns } = await pool.query<QueryResultRow>(
        `SELECT nonprofit_id, created_by_user_id FROM campaigns WHERE slug = $1`,
        [slug],
      );
      if (campaigns.length === 0) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      if (
        !(await userMayManageCampaignNonprofit(authUser, {
          nonprofit_id: Number(campaigns[0].nonprofit_id),
          created_by_user_id:
            campaigns[0].created_by_user_id != null
              ? Number(campaigns[0].created_by_user_id)
              : null,
        }))
      ) {
        res.status(403).json({ error: "Not allowed to manage this campaign" });
        return;
      }

      const rawStatus = String(req.query.status ?? "pending");
      const status =
        rawStatus === "accepted" ||
        rawStatus === "declined" ||
        rawStatus === "all" ||
        rawStatus === "pending"
          ? rawStatus
          : "pending";

      const result = await listPartnerJoinRequestsForCampaign(slug, status);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ requests: result.requests });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to list partner join requests" });
    }
  },
);

/**
 * POST /api/manage/campaigns/:slug/partner-join-requests/:id/accept
 */
campaignPartnerJoinManageRouter.post(
  "/campaigns/:slug/partner-join-requests/:id/accept",
  async (req, res) => {
    try {
      const authUser = await resolveAuthUser(bearerToken(req));
      if (!authUser) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const requestId = Number(req.params.id);
      if (!requestId) {
        res.status(400).json({ error: "Invalid request id" });
        return;
      }
      const result = await acceptPartnerJoinRequest({
        slug: String(req.params.slug ?? ""),
        requestId,
        user: authUser,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        request: result.request,
        invitationToken: result.invitationToken,
        acceptPath: result.acceptPath,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to accept partner join request" });
    }
  },
);

/**
 * POST /api/manage/campaigns/:slug/partner-join-requests/:id/decline
 * Body: { reason? }
 */
campaignPartnerJoinManageRouter.post(
  "/campaigns/:slug/partner-join-requests/:id/decline",
  async (req, res) => {
    try {
      const authUser = await resolveAuthUser(bearerToken(req));
      if (!authUser) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const requestId = Number(req.params.id);
      if (!requestId) {
        res.status(400).json({ error: "Invalid request id" });
        return;
      }
      const body = req.body as { reason?: string };
      const result = await declinePartnerJoinRequest({
        slug: String(req.params.slug ?? ""),
        requestId,
        user: authUser,
        reason: body.reason,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ request: result.request });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to decline partner join request" });
    }
  },
);
