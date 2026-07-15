import fs from "fs";
import path from "path";
import type { PoolClient, QueryResultRow } from "pg";
import {
  calculateDonationPool,
  calculateGivebackBreakdown,
} from "./financial-calculations";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads", "receipts");

export function ensureUploadsDir() {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not create uploads directory:", err);
  }
}

export function saveReceiptImage(base64: string, mimeType: string): string {
  ensureUploadsDir();
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const filename = `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  const data = base64.replace(/^data:[^;]+;base64,/, "");
  fs.writeFileSync(filepath, Buffer.from(data, "base64"));
  return `/uploads/receipts/${filename}`;
}

/** Donation pool from eligible sales (giveback path — separate from online donations). */
export function calculateDonation(eligibleSubtotal: number, givebackPercentage: number): number {
  return calculateDonationPool(eligibleSubtotal, givebackPercentage);
}

export async function approveReceipt(
  connection: PoolClient,
  receiptId: number,
  eligibleSubtotal?: number,
): Promise<void> {
  const { rows: rows } = await connection.query<QueryResultRow>(
    `SELECT r.*, cbl.giveback_percentage
     FROM receipts r
     LEFT JOIN campaign_business_locations cbl ON
       cbl.campaign_id = r.campaign_id
       AND cbl.business_id = r.business_id
       AND cbl.location_id = r.location_id
       AND cbl.method_id = r.method_id
     WHERE r.id = $1`,
    [receiptId],
  );
  if (rows.length === 0) throw new Error("Receipt not found");

  const receipt = rows[0];
  if (receipt.review_status === "approved") return;

  const giveback = Number(receipt.giveback_percentage ?? receipt.donation_percentage ?? 10);
  const eligible =
    eligibleSubtotal ??
    Number(receipt.eligible_subtotal) ??
    Number(receipt.subtotal);
  if (!eligible || eligible <= 0) throw new Error("Eligible subtotal is required to approve");

  const breakdown = calculateGivebackBreakdown(eligible, giveback);
  const donation = breakdown.donationPool;

  await connection.query(
    `UPDATE receipts SET
      eligible_subtotal = $1,
      subtotal = $2,
      donation_percentage = $3,
      calculated_donation = $4,
      ocr_status = 'approved',
      review_status = 'approved',
      approved_at = NOW()
     WHERE id = $5`,
    [eligible, eligible, giveback, donation, receiptId],
  );

  await connection.query(
    `UPDATE campaigns SET
      raised = raised + $1,
      verified_visits = verified_visits + 1,
      updated_at = NOW()
     WHERE id = $2`,
    [Math.round(donation), receipt.campaign_id],
  );

  if (receipt.business_id && receipt.location_id) {
    const { rows: existing } = await connection.query<QueryResultRow>(
      `SELECT id FROM settlements
       WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3`,
      [receipt.campaign_id, receipt.business_id, receipt.location_id],
    );

    if (existing.length > 0) {
      await connection.query(
        `UPDATE settlements SET
          eligible_sales = eligible_sales + $1,
          donation_pool = donation_pool + $2,
          forkup_fee = forkup_fee + $3,
          net_nonprofit_amount = net_nonprofit_amount + $4
         WHERE id = $5`,
        [
          eligible,
          donation,
          breakdown.platformFee,
          breakdown.netNonprofitAmount,
          existing[0].id,
        ],
      );
    } else {
      await connection.query<{ id: number }>(
        `INSERT INTO settlements (
          campaign_id, business_id, location_id,
          eligible_sales, donation_percentage, donation_pool,
          forkup_fee, net_nonprofit_amount, payment_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING id`,
        [
          receipt.campaign_id,
          receipt.business_id,
          receipt.location_id,
          eligible,
          giveback,
          donation,
          breakdown.platformFee,
          breakdown.netNonprofitAmount,
        ],
      );
    }
  }
}

export async function rejectReceipt(connection: PoolClient, receiptId: number): Promise<void> {
  await connection.query(
    `UPDATE receipts SET ocr_status = 'rejected', review_status = 'rejected' WHERE id = $1`,
    [receiptId],
  );
}
