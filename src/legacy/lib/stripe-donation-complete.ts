/**
 * Mark a pending Stripe online donation as completed (idempotent).
 *
 * Purpose: Shared by webhook + confirm-checkout so raised totals bump once.
 * Inputs: stripeCheckoutSessionId, optional paymentIntentId
 * Outputs: { completed, donationId?, amount?, campaignId? } or null if not found
 *
 * Changelog: Pass 2 — Stripe online donation integration.
 */
import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";

export type CompleteStripeDonationResult = {
  found: boolean;
  completed: boolean;
  donationId?: number;
  amount?: number;
  campaignId?: number;
  alreadyCompleted?: boolean;
};

/**
 * Completes a pending donation row keyed by Checkout Session id.
 * Inputs: sessionId, paymentIntentId (optional)
 * Outputs: CompleteStripeDonationResult
 */
export async function completeStripeDonationBySession(
  sessionId: string,
  paymentIntentId: string | null,
): Promise<CompleteStripeDonationResult> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows: existing } = await connection.query<QueryResultRow>(
      `SELECT id, campaign_id, amount, payment_status
       FROM donations
       WHERE stripe_checkout_session_id = $1
       LIMIT 1`,
      [sessionId],
    );

    if (existing.length === 0) {
      await connection.query("ROLLBACK");
      return { found: false, completed: false };
    }

    const row = existing[0];
    if (String(row.payment_status) === "completed") {
      await connection.query("COMMIT");
      return {
        found: true,
        completed: false,
        alreadyCompleted: true,
        donationId: Number(row.id),
        amount: Number(row.amount),
        campaignId: Number(row.campaign_id),
      };
    }

    if (String(row.payment_status) !== "pending") {
      await connection.query("COMMIT");
      return {
        found: true,
        completed: false,
        donationId: Number(row.id),
        amount: Number(row.amount),
        campaignId: Number(row.campaign_id),
      };
    }

    const { rows: updated } = await connection.query<QueryResultRow>(
      `UPDATE donations
       SET payment_status = 'completed',
           stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id)
       WHERE id = $1 AND payment_status = 'pending'
       RETURNING id, campaign_id, amount`,
      [row.id, paymentIntentId],
    );

    if (updated.length === 0) {
      await connection.query("COMMIT");
      return {
        found: true,
        completed: false,
        alreadyCompleted: true,
        donationId: Number(row.id),
        amount: Number(row.amount),
        campaignId: Number(row.campaign_id),
      };
    }

    const donationAmount = Number(updated[0].amount);
    const campaignId = Number(updated[0].campaign_id);

    await connection.query(
      `UPDATE campaigns SET raised = raised + $1, updated_at = NOW() WHERE id = $2`,
      [Math.round(donationAmount), campaignId],
    );

    await connection.query("COMMIT");

    return {
      found: true,
      completed: true,
      donationId: Number(updated[0].id),
      amount: donationAmount,
      campaignId,
    };
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }
}
