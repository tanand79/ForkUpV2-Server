import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { processReceiptOcr } from "../lib/ocr";
import {
  approveReceipt,
  calculateDonation,
  rejectReceipt,
  saveReceiptImage,
} from "../lib/receipts";
import { pool } from "../db/pool";

export const receiptsRouter = Router();

type ReceiptRow = QueryResultRow & {
  id: number;
  uploaded_image_url: string;
  ocr_status: string;
  review_status: string;
  subtotal: number | null;
  eligible_subtotal: number | null;
  donation_percentage: number | null;
  calculated_donation: number | null;
  uploaded_at: Date;
  business_name: string | null;
  location_name: string | null;
  supporter_email: string | null;
  supporter_name: string | null;
};

function mapReceipt(row: ReceiptRow) {
  return {
    id: row.id,
    imageUrl: row.uploaded_image_url,
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

receiptsRouter.post("/campaigns/:slug/receipts", async (req, res) => {
  const connection = await pool.connect();
  try {
    const {
      firstName,
      email,
      businessId,
      locationId,
      methodId,
      imageBase64,
      imageMimeType,
      claimedSubtotal,
    } = req.body as Record<string, unknown>;

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

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaigns WHERE slug = $1 AND campaign_status IN ('live', 'ready_to_launch', 'closed')`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found or not accepting receipts" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows: cbl } = await connection.query<QueryResultRow>(
      `SELECT giveback_percentage FROM campaign_business_locations
       WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3 AND method_id = $4
         AND acceptance_status IN ('accepted', 'live', 'completed')`,
      [campaignId, bizId, locId, methId],
    );
    if (cbl.length === 0) {
      res.status(400).json({ error: "Selected location is not an accepted participant" });
      return;
    }

    const giveback = Number(cbl[0].giveback_percentage);
    const claimed =
      claimedSubtotal != null && Number(claimedSubtotal) > 0 ? Number(claimedSubtotal) : null;

    await connection.query("BEGIN");

    const normalizedEmail = email.trim().toLowerCase();
    const { rows: existingSupporters } = await connection.query<QueryResultRow>(
      "SELECT id FROM supporters WHERE email = $1",
      [normalizedEmail],
    );
    let supporterId: number;
    if (existingSupporters.length > 0) {
      supporterId = Number(existingSupporters[0].id);
    } else {
      const { rows: supporterResult } = await connection.query<{ id: number }>(
        "INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id",
        [firstName.trim(), normalizedEmail],
      );
      supporterId = supporterResult[0].id;
    }

    const mime = typeof imageMimeType === "string" ? imageMimeType : "image/jpeg";
    const imageUrl = saveReceiptImage(imageBase64, mime);

    const { rows: receiptResult } = await connection.query<{ id: number }>(
      `INSERT INTO receipts (
        campaign_id, method_id, business_id, location_id, supporter_id,
        uploaded_image_url, ocr_status, review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', 'pending') RETURNING id`,
      [campaignId, methId, bizId, locId, supporterId, imageUrl],
    );
    const receiptId = receiptResult[0].id;

    const ocr = processReceiptOcr(claimed);
    const donation =
      ocr.eligibleSubtotal > 0 ? calculateDonation(ocr.eligibleSubtotal, giveback) : null;

    await connection.query(
      `UPDATE receipts SET
        ocr_status = $1,
        subtotal = $2,
        eligible_subtotal = $3,
        donation_percentage = $4,
        calculated_donation = $5
       WHERE id = $6`,
      [
        ocr.status,
        ocr.subtotal || null,
        ocr.eligibleSubtotal || null,
        giveback,
        donation,
        receiptId,
      ],
    );

    await connection.query("COMMIT");

    res.status(201).json({
      id: receiptId,
      ocrStatus: ocr.status,
      reviewStatus: "pending",
      eligibleSubtotal: ocr.eligibleSubtotal || null,
      calculatedDonation: donation,
      donationPercentage: giveback,
      imageUrl,
      message: ocr.notes,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to upload receipt" });
  } finally {
    connection.release();
  }
});

receiptsRouter.get("/campaigns/:slug/receipts", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const { rows: campaigns } = await pool.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const params: (string | number)[] = [campaigns[0].id];
    let statusClause = "";
    if (status) {
      statusClause = " AND r.review_status = $2";
      params.push(status);
    }

    const { rows: rows } = await pool.query<ReceiptRow>(
      `SELECT
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
       ORDER BY r.uploaded_at DESC`,
      params,
    );

    res.json(rows.map(mapReceipt));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch receipts" });
  }
});

receiptsRouter.post("/receipts/:id/review", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { action, eligibleSubtotal } = req.body as {
      action?: string;
      eligibleSubtotal?: number;
    };

    if (!["approve", "reject"].includes(action ?? "")) {
      res.status(400).json({ error: "Action must be approve or reject" });
      return;
    }

    await connection.query("BEGIN");

    if (action === "approve") {
      await approveReceipt(connection, Number(req.params.id), eligibleSubtotal);
    } else {
      await rejectReceipt(connection, Number(req.params.id));
    }

    await connection.query("COMMIT");
    res.json({ success: true, action });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to review receipt",
    });
  } finally {
    connection.release();
  }
});
