"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.campaignPartnerJoinManageRouter = exports.campaignPartnerJoinBusinessRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const campaign_partner_join_requests_1 = require("../lib/campaign-partner-join-requests");
const pool_1 = require("../db/pool");
exports.campaignPartnerJoinBusinessRouter = (0, express_1.Router)();
exports.campaignPartnerJoinManageRouter = (0, express_1.Router)();
exports.campaignPartnerJoinBusinessRouter.post("/campaigns/:slug/partner-join-requests", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const body = req.body;
        const businessId = Number(body.businessId);
        if (!businessId) {
            res.status(400).json({ error: "businessId is required" });
            return;
        }
        const result = await (0, campaign_partner_join_requests_1.createPartnerJoinRequest)({
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create partner join request" });
    }
});
exports.campaignPartnerJoinBusinessRouter.get("/campaigns/:slug/partner-join-requests/mine", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const businessId = Number(req.query.businessId);
        if (!businessId) {
            res.status(400).json({ error: "businessId query param is required" });
            return;
        }
        const result = await (0, campaign_partner_join_requests_1.listMyPartnerJoinRequests)({
            slug: String(req.params.slug ?? ""),
            user: authUser,
            businessId,
        });
        if (!result.ok) {
            res.status(result.status).json({ error: result.error });
            return;
        }
        res.json({ requests: result.requests });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to list partner join requests" });
    }
});
exports.campaignPartnerJoinManageRouter.get("/campaigns/:slug/partner-join-requests", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const slug = String(req.params.slug ?? "").replace(/\/+$/, "");
        const { rows: campaigns } = await pool_1.pool.query(`SELECT nonprofit_id, created_by_user_id FROM campaigns WHERE slug = $1`, [slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        if (!(await (0, campaign_partner_join_requests_1.userMayManageCampaignNonprofit)(authUser, {
            nonprofit_id: Number(campaigns[0].nonprofit_id),
            created_by_user_id: campaigns[0].created_by_user_id != null
                ? Number(campaigns[0].created_by_user_id)
                : null,
        }))) {
            res.status(403).json({ error: "Not allowed to manage this campaign" });
            return;
        }
        const rawStatus = String(req.query.status ?? "pending");
        const status = rawStatus === "accepted" ||
            rawStatus === "declined" ||
            rawStatus === "all" ||
            rawStatus === "pending"
            ? rawStatus
            : "pending";
        const result = await (0, campaign_partner_join_requests_1.listPartnerJoinRequestsForCampaign)(slug, status);
        if (!result.ok) {
            res.status(result.status).json({ error: result.error });
            return;
        }
        res.json({ requests: result.requests });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to list partner join requests" });
    }
});
exports.campaignPartnerJoinManageRouter.post("/campaigns/:slug/partner-join-requests/:id/accept", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const requestId = Number(req.params.id);
        if (!requestId) {
            res.status(400).json({ error: "Invalid request id" });
            return;
        }
        const result = await (0, campaign_partner_join_requests_1.acceptPartnerJoinRequest)({
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to accept partner join request" });
    }
});
exports.campaignPartnerJoinManageRouter.post("/campaigns/:slug/partner-join-requests/:id/decline", async (req, res) => {
    try {
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!authUser) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const requestId = Number(req.params.id);
        if (!requestId) {
            res.status(400).json({ error: "Invalid request id" });
            return;
        }
        const body = req.body;
        const result = await (0, campaign_partner_join_requests_1.declinePartnerJoinRequest)({
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to decline partner join request" });
    }
});
//# sourceMappingURL=campaign-partner-join-requests.js.map