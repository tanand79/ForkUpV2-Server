import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { processReceiptOcr } from "../lib/ocr";
import { extractReceiptWithMindee } from "../lib/mindee-ocr";
import {
  approveReceipt,
  calculateDonation,
  rejectReceipt,
  saveReceiptImage,
} from "../lib/receipts";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import { resolveAuthUser, bearerToken } from "../lib/auth";
import { resolveStoredImageUrl } from "../lib/s3";
import { pool } from "../db/pool";

export const receiptsRouter = Router();

/**
 * Notifies the supporter that their uploaded receipt was approved or rejected.
 * Idempotent per receipt + action; uses the mailer, which never throws.
 */
async function notifySupporterOfReceiptReview(
  receiptId: number,
  action: "approve" | "reject",
): Promise<void> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT s.email AS supporter_email, s.first_name AS supporter_name,
            b.business_name, c.campaign_name, c.slug AS campaign_slug,
            r.calculated_donation, r.campaign_id
     FROM receipts r
     LEFT JOIN supporters s ON s.id = r.supporter_id
     LEFT JOIN businesses b ON b.id = r.business_id
     LEFT JOIN campaigns c ON c.id = r.campaign_id
     WHERE r.id = $1`,
    [receiptId],
  );
  const row = rows[0];
  const email = typeof row?.supporter_email === "string" ? row.supporter_email.trim() : "";
  if (!row || !email) return;

  const name = typeof row.supporter_name === "string" && row.supporter_name.trim()
    ? row.supporter_name.trim()
    : "there";
  const businessName = row.business_name ?? "the participating business";
  const campaignName = row.campaign_name ?? "the campaign";
  const campaignUrl = row.campaign_slug
    ? `${resolveFrontendBaseUrl()}/campaign/${row.campaign_slug}`
    : resolveFrontendBaseUrl();

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

  await sendEmail({
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

async function mapReceipt(row: ReceiptRow) {
  return {
    id: row.id,
    imageUrl: await resolveStoredImageUrl(row.uploaded_image_url),
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
    const imageUrl = await saveReceiptImage(imageBase64, mime);

    const { rows: receiptResult } = await connection.query<{ id: number }>(
      `INSERT INTO receipts (
        campaign_id, method_id, business_id, location_id, supporter_id,
        uploaded_image_url, ocr_status, review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', 'pending') RETURNING id`,
      [campaignId, methId, bizId, locId, supporterId, imageUrl],
    );
    const receiptId = receiptResult[0].id;

    // Prefer Mindee when configured; otherwise keep placeholder OCR behavior.
    const mindee = await extractReceiptWithMindee({
      imageBase64,
      mimeType: mime,
      claimedSubtotal: claimed,
    });
    const placeholder = processReceiptOcr(claimed);
    const useMindee = Boolean(mindee.ocrProvider);
    const ocrStatus = useMindee ? mindee.ocrStatus : placeholder.status;
    const eligibleSubtotal = useMindee
      ? mindee.eligibleSubtotal
      : placeholder.eligibleSubtotal;
    const subtotal = useMindee ? mindee.subtotal : placeholder.subtotal;
    const message = useMindee ? mindee.message : placeholder.notes;
    const donation =
      eligibleSubtotal > 0 ? calculateDonation(eligibleSubtotal, giveback) : null;

    await connection.query(
      `UPDATE receipts SET
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
       WHERE id = $20`,
      [
        ocrStatus,
        subtotal || null,
        eligibleSubtotal || null,
        giveback,
        donation,
        useMindee ? mindee.ocrProvider : null,
        useMindee ? mindee.ocrProcessedAt : null,
        useMindee ? mindee.ocrExtractStatus : "pending",
        useMindee ? mindee.merchantName : null,
        useMindee ? mindee.receiptNumber : null,
        useMindee ? mindee.dateString : null,
        useMindee ? mindee.timeString : null,
        useMindee ? mindee.receiptDate : null,
        useMindee && mindee.total > 0 ? mindee.total : null,
        useMindee && mindee.tax > 0 ? mindee.tax : null,
        useMindee && mindee.totalLineItems > 0 ? mindee.totalLineItems : null,
        useMindee && mindee.extractedJson ? JSON.stringify(mindee.extractedJson) : null,
        useMindee ? mindee.message : placeholder.notes,
        useMindee ? mindee.isManualSubtotal : claimed == null,
        receiptId,
      ],
    );

    await connection.query("COMMIT");

    res.status(201).json({
      id: receiptId,
      ocrStatus,
      reviewStatus: "pending",
      eligibleSubtotal: eligibleSubtotal || null,
      calculatedDonation: donation,
      donationPercentage: giveback,
      imageUrl: await resolveStoredImageUrl(imageUrl),
      message,
      ocrExtractStatus: useMindee ? mindee.ocrExtractStatus : "pending",
      ocrProvider: useMindee ? mindee.ocrProvider : null,
      merchantName: useMindee ? mindee.merchantName : null,
      isManualSubtotal: useMindee ? mindee.isManualSubtotal : claimed == null,
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

    res.json(await Promise.all(rows.map(mapReceipt)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch receipts" });
  }
});

/**
 * Receipt history for the signed-in supporter. Scoped by the authenticated
 * user's email (matched against the lightweight `supporters` table), so no
 * arbitrary email lookups are possible. Read-only.
 */
receiptsRouter.get("/receipts/mine", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Sign in to view your receipts" });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT
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
       ORDER BY r.uploaded_at DESC`,
      [user.email],
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        ocrStatus: row.ocr_status,
        reviewStatus: row.review_status,
        eligibleSubtotal: row.eligible_subtotal != null ? Number(row.eligible_subtotal) : null,
        donationPercentage:
          row.donation_percentage != null ? Number(row.donation_percentage) : null,
        calculatedDonation:
          row.calculated_donation != null ? Number(row.calculated_donation) : null,
        uploadedAt: row.uploaded_at,
        campaignName: row.campaign_name ?? null,
        campaignSlug: row.campaign_slug ?? null,
        businessName: row.business_name ?? null,
        locationName: row.location_name ?? null,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch your receipts" });
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

    await notifySupporterOfReceiptReview(
      Number(req.params.id),
      action === "approve" ? "approve" : "reject",
    );

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
