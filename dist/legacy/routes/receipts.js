"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.receiptsRouter = void 0;
const express_1 = require("express");
const ocr_1 = require("../lib/ocr");
const receipt_ocr_engine_1 = require("../lib/receipt-ocr-engine");
const receipts_1 = require("../lib/receipts");
const mailer_1 = require("../lib/mailer");
const auth_1 = require("../lib/auth");
const s3_1 = require("../lib/s3");
const pool_1 = require("../db/pool");
const receipt_duplicates_1 = require("../lib/receipt-duplicates");
const receipt_upload_window_1 = require("../lib/receipt-upload-window");
exports.receiptsRouter = (0, express_1.Router)();
async function notifySupporterOfReceiptReview(receiptId, action) {
    const { rows } = await pool_1.pool.query(`SELECT s.email AS supporter_email, s.first_name AS supporter_name,
            b.business_name, c.campaign_name, c.slug AS campaign_slug,
            r.calculated_donation, r.campaign_id
     FROM receipts r
     LEFT JOIN supporters s ON s.id = r.supporter_id
     LEFT JOIN businesses b ON b.id = r.business_id
     LEFT JOIN campaigns c ON c.id = r.campaign_id
     WHERE r.id = $1`, [receiptId]);
    const row = rows[0];
    const email = typeof row?.supporter_email === "string" ? row.supporter_email.trim() : "";
    if (!row || !email)
        return;
    const name = typeof row.supporter_name === "string" && row.supporter_name.trim()
        ? row.supporter_name.trim()
        : "there";
    const businessName = row.business_name ?? "the participating business";
    const campaignName = row.campaign_name ?? "the campaign";
    const campaignUrl = row.campaign_slug
        ? `${(0, mailer_1.resolveFrontendBaseUrl)()}/campaign/${row.campaign_slug}`
        : (0, mailer_1.resolveFrontendBaseUrl)();
    const approved = action === "approve";
    const donation = Number(row.calculated_donation ?? 0);
    const body = approved
        ? `Hi ${name},\n\n` +
            `Your receipt from ${businessName} for "${campaignName}" has been approved.` +
            (donation > 0 ? ` It generated a donation of $${donation.toFixed(2)}.` : "") +
            `\n\nThank you for supporting this campaign!\n${campaignUrl}\n\n— ForkUp`
        : `Hi ${name},\n\n` +
            `We were unable to approve your receipt from ${businessName} for "${campaignName}". ` +
            `This can happen if the receipt was unclear or did not meet the campaign's eligibility rules.\n\n` +
            `You're welcome to upload another receipt here:\n${campaignUrl}\n\n— ForkUp`;
    await (0, mailer_1.sendEmail)({
        to: email,
        name: typeof row.supporter_name === "string" ? row.supporter_name : null,
        subject: approved
            ? `Your receipt for "${campaignName}" was approved`
            : `Update on your receipt for "${campaignName}"`,
        body,
        emailType: approved ? "receipt_approved" : "receipt_rejected",
        campaignId: row.campaign_id ?? null,
        stakeholderRole: "supporter",
        relatedToken: `receipt:${receiptId}:${action}`,
        onlyOnce: true,
    });
}
async function mapReceipt(row) {
    return {
        id: row.id,
        imageUrl: await (0, s3_1.resolveStoredImageUrl)(row.uploaded_image_url),
        ocrStatus: row.ocr_status,
        reviewStatus: row.review_status,
        subtotal: row.subtotal != null ? Number(row.subtotal) : null,
        eligibleSubtotal: row.eligible_subtotal != null ? Number(row.eligible_subtotal) : null,
        donationPercentage: row.donation_percentage != null ? Number(row.donation_percentage) : null,
        calculatedDonation: row.calculated_donation != null ? Number(row.calculated_donation) : null,
        uploadedAt: row.uploaded_at,
        businessName: row.business_name,
        locationName: row.location_name,
        supporterEmail: row.supporter_email,
        supporterName: row.supporter_name,
    };
}
exports.receiptsRouter.post("/campaigns/:slug/receipts", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const { firstName, email, businessId, locationId, methodId, imageBase64, imageMimeType, claimedSubtotal, receiptModelId, } = req.body;
        if (!firstName || typeof firstName !== "string") {
            res.status(400).json({ error: "First name is required" });
            return;
        }
        if (!email || typeof email !== "string" || !email.includes("@")) {
            res.status(400).json({ error: "Valid email is required" });
            return;
        }
        if (!imageBase64 || typeof imageBase64 !== "string") {
            res.status(400).json({ error: "Receipt image is required" });
            return;
        }
        const bizId = Number(businessId);
        const locId = Number(locationId);
        const methId = Number(methodId);
        if (!bizId || !locId || !methId) {
            res.status(400).json({ error: "Business, location, and method are required" });
            return;
        }
        const { rows: campaigns } = await connection.query(`SELECT id, campaign_status, campaign_end_date, settlement_grace_days,
              settlement_frozen_at, adjustment_window_end
       FROM campaigns WHERE slug = $1`, [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found or not accepting receipts" });
            return;
        }
        const windowReason = (0, receipt_upload_window_1.receiptUploadBlockedReason)(campaigns[0]);
        if (windowReason) {
            const status = windowReason.includes("not found") ? 404 : 400;
            res.status(status).json({ error: windowReason });
            return;
        }
        const campaignId = Number(campaigns[0].id);
        const { rows: cbl } = await connection.query(`SELECT giveback_percentage FROM campaign_business_locations
       WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3 AND method_id = $4
         AND acceptance_status IN ('accepted', 'live', 'completed')`, [campaignId, bizId, locId, methId]);
        if (cbl.length === 0) {
            res.status(400).json({ error: "Selected location is not an accepted participant" });
            return;
        }
        const giveback = Number(cbl[0].giveback_percentage);
        const claimed = claimedSubtotal != null && Number(claimedSubtotal) > 0 ? Number(claimedSubtotal) : null;
        await connection.query("BEGIN");
        const normalizedEmail = email.trim().toLowerCase();
        const { rows: existingSupporters } = await connection.query("SELECT id FROM supporters WHERE email = $1", [normalizedEmail]);
        let supporterId;
        if (existingSupporters.length > 0) {
            supporterId = Number(existingSupporters[0].id);
        }
        else {
            const { rows: supporterResult } = await connection.query("INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id", [firstName.trim(), normalizedEmail]);
            supporterId = supporterResult[0].id;
        }
        const mime = typeof imageMimeType === "string" ? imageMimeType : "image/jpeg";
        const imageUrl = await (0, receipts_1.saveReceiptImage)(imageBase64, mime);
        const { rows: receiptResult } = await connection.query(`INSERT INTO receipts (
        campaign_id, method_id, business_id, location_id, supporter_id,
        uploaded_image_url, ocr_status, review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', 'pending') RETURNING id`, [campaignId, methId, bizId, locId, supporterId, imageUrl]);
        const receiptId = receiptResult[0].id;
        const authUser = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        const modelFromBody = typeof receiptModelId === "string" && receiptModelId.trim() ? receiptModelId.trim() : null;
        const ocr = await (0, receipt_ocr_engine_1.extractReceiptOcr)({
            imageBase64,
            mimeType: mime,
            claimedSubtotal: claimed,
            bedrockModelId: modelFromBody,
            userId: authUser?.id ?? null,
        });
        const placeholder = (0, ocr_1.processReceiptOcr)(claimed);
        const useOcr = Boolean(ocr.ocrProvider);
        const ocrStatus = useOcr ? ocr.ocrStatus : placeholder.status;
        const eligibleSubtotal = useOcr
            ? ocr.eligibleSubtotal
            : placeholder.eligibleSubtotal;
        const subtotal = useOcr ? ocr.subtotal : placeholder.subtotal;
        const message = useOcr ? ocr.message : placeholder.notes;
        const donation = eligibleSubtotal > 0 ? (0, receipts_1.calculateDonation)(eligibleSubtotal, giveback) : null;
        await connection.query(`UPDATE receipts SET
        ocr_status = $1,
        subtotal = $2,
        eligible_subtotal = $3,
        donation_percentage = $4,
        calculated_donation = $5,
        ocr_provider = $6,
        ocr_processed_at = $7,
        ocr_extract_status = $8,
        ocr_merchant_name = $9,
        ocr_receipt_number = $10,
        ocr_date_string = $11,
        ocr_time_string = $12,
        ocr_receipt_date = $13,
        ocr_total = $14,
        ocr_tax = $15,
        ocr_total_line_items = $16,
        ocr_extracted_json = $17,
        ocr_message = $18,
        is_manual_subtotal = $19
       WHERE id = $20`, [
            ocrStatus,
            subtotal || null,
            eligibleSubtotal || null,
            giveback,
            donation,
            useOcr ? ocr.ocrProvider : null,
            useOcr ? ocr.ocrProcessedAt : null,
            useOcr ? ocr.ocrExtractStatus : "pending",
            useOcr ? ocr.merchantName : null,
            useOcr ? ocr.receiptNumber : null,
            useOcr ? ocr.dateString : null,
            useOcr ? ocr.timeString : null,
            useOcr ? ocr.receiptDate : null,
            useOcr && ocr.total > 0 ? ocr.total : null,
            useOcr && ocr.tax > 0 ? ocr.tax : null,
            useOcr && ocr.totalLineItems > 0 ? ocr.totalLineItems : null,
            useOcr && ocr.extractedJson ? JSON.stringify(ocr.extractedJson) : null,
            useOcr ? ocr.message : placeholder.notes,
            useOcr ? ocr.isManualSubtotal : claimed == null,
            receiptId,
        ]);
        const duplicate = await (0, receipt_duplicates_1.findDuplicateReceipt)(connection, campaignId, locId, {
            receiptNumber: useOcr ? ocr.receiptNumber : null,
            dateString: useOcr ? ocr.dateString : null,
            timeString: useOcr ? ocr.timeString : null,
            subtotal: subtotal || claimed,
            total: useOcr && ocr.total > 0 ? ocr.total : null,
        }, receiptId);
        if (duplicate) {
            await connection.query("ROLLBACK");
            res.status(409).json({
                error: "This receipt looks like a duplicate of one already uploaded.",
                reason: duplicate.reason,
                existingReceiptId: duplicate.receiptId,
            });
            return;
        }
        await connection.query("COMMIT");
        res.status(201).json({
            id: receiptId,
            ocrStatus,
            reviewStatus: "pending",
            eligibleSubtotal: eligibleSubtotal || null,
            calculatedDonation: donation,
            donationPercentage: giveback,
            imageUrl: await (0, s3_1.resolveStoredImageUrl)(imageUrl),
            message,
            ocrExtractStatus: useOcr ? ocr.ocrExtractStatus : "pending",
            ocrProvider: useOcr ? ocr.ocrProvider : null,
            merchantName: useOcr ? ocr.merchantName : null,
            isManualSubtotal: useOcr ? ocr.isManualSubtotal : claimed == null,
        });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ error: "Failed to upload receipt" });
    }
    finally {
        connection.release();
    }
});
exports.receiptsRouter.get("/campaigns/:slug/receipts", async (req, res) => {
    try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const { rows: campaigns } = await pool_1.pool.query("SELECT id FROM campaigns WHERE slug = $1", [req.params.slug]);
        if (campaigns.length === 0) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const params = [campaigns[0].id];
        let statusClause = "";
        if (status) {
            statusClause = " AND r.review_status = $2";
            params.push(status);
        }
        const { rows: rows } = await pool_1.pool.query(`SELECT
         r.*,
         b.business_name,
         bl.location_name,
         s.email AS supporter_email,
         s.first_name AS supporter_name
       FROM receipts r
       LEFT JOIN businesses b ON b.id = r.business_id
       LEFT JOIN business_locations bl ON bl.id = r.location_id
       LEFT JOIN supporters s ON s.id = r.supporter_id
       WHERE r.campaign_id = $1${statusClause}
       ORDER BY r.uploaded_at DESC`, params);
        res.json(await Promise.all(rows.map(mapReceipt)));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch receipts" });
    }
});
exports.receiptsRouter.get("/receipts/mine", async (req, res) => {
    try {
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        if (!user) {
            res.status(401).json({ error: "Sign in to view your receipts" });
            return;
        }
        const { rows } = await pool_1.pool.query(`SELECT
         r.id,
         r.ocr_status,
         r.review_status,
         r.eligible_subtotal,
         r.donation_percentage,
         r.calculated_donation,
         r.uploaded_at,
         c.campaign_name,
         c.slug AS campaign_slug,
         b.business_name,
         bl.location_name
       FROM receipts r
       JOIN supporters s ON s.id = r.supporter_id
       LEFT JOIN campaigns c ON c.id = r.campaign_id
       LEFT JOIN businesses b ON b.id = r.business_id
       LEFT JOIN business_locations bl ON bl.id = r.location_id
       WHERE LOWER(s.email) = LOWER($1)
       ORDER BY r.uploaded_at DESC`, [user.email]);
        res.json(rows.map((row) => ({
            id: row.id,
            ocrStatus: row.ocr_status,
            reviewStatus: row.review_status,
            eligibleSubtotal: row.eligible_subtotal != null ? Number(row.eligible_subtotal) : null,
            donationPercentage: row.donation_percentage != null ? Number(row.donation_percentage) : null,
            calculatedDonation: row.calculated_donation != null ? Number(row.calculated_donation) : null,
            uploadedAt: row.uploaded_at,
            campaignName: row.campaign_name ?? null,
            campaignSlug: row.campaign_slug ?? null,
            businessName: row.business_name ?? null,
            locationName: row.location_name ?? null,
        })));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch your receipts" });
    }
});
exports.receiptsRouter.post("/receipts/:id/review", async (req, res) => {
    const connection = await pool_1.pool.connect();
    try {
        const { action, eligibleSubtotal } = req.body;
        if (!["approve", "reject"].includes(action ?? "")) {
            res.status(400).json({ error: "Action must be approve or reject" });
            return;
        }
        await connection.query("BEGIN");
        if (action === "approve") {
            await (0, receipts_1.approveReceipt)(connection, Number(req.params.id), eligibleSubtotal);
        }
        else {
            await (0, receipts_1.rejectReceipt)(connection, Number(req.params.id));
        }
        await connection.query("COMMIT");
        await notifySupporterOfReceiptReview(Number(req.params.id), action === "approve" ? "approve" : "reject");
        res.json({ success: true, action });
    }
    catch (err) {
        await connection.query("ROLLBACK");
        console.error(err);
        res.status(500).json({
            error: err instanceof Error ? err.message : "Failed to review receipt",
        });
    }
    finally {
        connection.release();
    }
});
//# sourceMappingURL=receipts.js.map