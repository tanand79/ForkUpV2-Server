/**
 * Public settlement ACH approval API (no login — token in email link).
 *
 * GET  /api/settlement-ach/:token
 *   Response: { approval: SettlementAchApprovalView }
 *
 * POST /api/settlement-ach/:token/approve
 *   Body: { approvedByName, approvedByEmail }
 *   Response: { ok: true, approval: SettlementAchApprovalView }
 */
import { Router } from "express";
import {
  approveSettlementAch,
  loadSettlementAchApproval,
} from "../lib/settlement-ach-approval";

export const settlementAchApprovalRouter = Router();

settlementAchApprovalRouter.get("/settlement-ach/:token", async (req, res) => {
  try {
    const approval = await loadSettlementAchApproval(req.params.token);
    if (!approval) {
      res.status(404).json({ error: "Approval link not found or expired" });
      return;
    }
    res.json({ approval });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load ACH approval" });
  }
});

settlementAchApprovalRouter.post("/settlement-ach/:token/approve", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const approvedByName =
      typeof body.approvedByName === "string" ? body.approvedByName.trim() : "";
    const approvedByEmail =
      typeof body.approvedByEmail === "string" ? body.approvedByEmail.trim() : "";
    if (!approvedByName || !approvedByEmail.includes("@")) {
      res.status(400).json({ error: "approvedByName and approvedByEmail are required" });
      return;
    }

    const approval = await approveSettlementAch(
      req.params.token,
      approvedByName,
      approvedByEmail,
    );
    if (!approval) {
      res.status(404).json({ error: "Approval link not found" });
      return;
    }
    res.json({ ok: true, approval });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve ACH" });
  }
});
