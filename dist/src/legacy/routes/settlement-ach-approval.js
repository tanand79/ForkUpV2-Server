"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settlementAchApprovalRouter = void 0;
const express_1 = require("express");
const settlement_ach_approval_1 = require("../lib/settlement-ach-approval");
exports.settlementAchApprovalRouter = (0, express_1.Router)();
exports.settlementAchApprovalRouter.get("/settlement-ach/:token", async (req, res) => {
    try {
        const approval = await (0, settlement_ach_approval_1.loadSettlementAchApproval)(req.params.token);
        if (!approval) {
            res.status(404).json({ error: "Approval link not found or expired" });
            return;
        }
        res.json({ approval });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load ACH approval" });
    }
});
exports.settlementAchApprovalRouter.post("/settlement-ach/:token/approve", async (req, res) => {
    try {
        const body = req.body;
        const approvedByName = typeof body.approvedByName === "string" ? body.approvedByName.trim() : "";
        const approvedByEmail = typeof body.approvedByEmail === "string" ? body.approvedByEmail.trim() : "";
        if (!approvedByName || !approvedByEmail.includes("@")) {
            res.status(400).json({ error: "approvedByName and approvedByEmail are required" });
            return;
        }
        const approval = await (0, settlement_ach_approval_1.approveSettlementAch)(req.params.token, approvedByName, approvedByEmail);
        if (!approval) {
            res.status(404).json({ error: "Approval link not found" });
            return;
        }
        res.json({ ok: true, approval });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to approve ACH" });
    }
});
//# sourceMappingURL=settlement-ach-approval.js.map