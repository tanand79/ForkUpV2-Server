/**
 * Stripe Checkout routes for online (virtual) donations.
 *
 * Endpoints:
 * - GET  /api/stripe/config
 *   Request: none
 *   Response: { configured, publishableKey }
 *
 * - POST /api/campaigns/:slug/donations/checkout
 *   Request: { amount, email, donorName?, anonymous?, attributionCode? }
 *   Response: { url, sessionId, donationId, publishableKey }
 *
 * - GET  /api/campaigns/:slug/donations/confirm-checkout?session_id=
 *   Request: query session_id
 *   Response: { success, amount?, raised?, alreadyCompleted? }
 *
 * - POST /api/stripe/webhook  (raw body; mounted separately)
 *   Request: Stripe-Signature + raw JSON
 *   Response: { received: true }
 *
 * Changelog: Pass 2 — Stripe online donation integration.
 * Does not modify existing POST /api/campaigns/:slug/donations.
 */
import { Router, type Request, type Response } from "express";
import type { QueryResultRow } from "pg";
import { config } from "../config";
import { pool } from "../db/pool";
import { resolveFrontendBaseUrl } from "../lib/mailer";
import { getStripe, isStripeConfigured } from "../lib/stripe-client";
import { completeStripeDonationBySession } from "../lib/stripe-donation-complete";

export const stripeConfigRouter = Router();
export const stripeCheckoutRouter = Router();

/**
 * GET /config — public publishable key for the donate UI.
 */
stripeConfigRouter.get("/config", (_req, res) => {
  res.json({
    configured: isStripeConfigured(),
    publishableKey: config.stripe.publishableKey || null,
  });
});

/**
 * POST /:slug/donations/checkout
 * Creates a pending donation + Stripe Checkout Session; returns redirect URL.
 */
stripeCheckoutRouter.post("/:slug/donations/checkout", async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    res.status(503).json({
      error: "Online card donations are not configured. Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY.",
    });
    return;
  }

  const connection = await pool.connect();
  try {
    const { amount, donorName, email, anonymous, attributionCode } = req.body as Record<
      string,
      unknown
    >;

    const donationAmount = Number(amount);
    if (!Number.isFinite(donationAmount) || donationAmount < 1) {
      res.status(400).json({ error: "Valid donation amount is required (minimum $1)" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      `SELECT c.id, c.campaign_status, c.slug, c.campaign_name, n.organization_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE c.slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];
    if (String(campaign.campaign_status) !== "live") {
      res.status(400).json({ error: "This campaign is not accepting donations yet" });
      return;
    }

    const campaignId = Number(campaign.id);
    const slug = String(campaign.slug);
    const normalizedEmail = email.trim().toLowerCase();
    const isAnonymous = Boolean(anonymous);
    const displayName =
      isAnonymous || !donorName || typeof donorName !== "string"
        ? "Anonymous"
        : donorName.trim();

    await connection.query("BEGIN");

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
        [displayName, normalizedEmail],
      );
      supporterId = supporterResult[0].id;
    }

    const { rows: methods } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaign_methods
       WHERE campaign_id = $1 AND method_type = 'virtual_donations' LIMIT 1`,
      [campaignId],
    );
    const methodId = methods.length > 0 ? Number(methods[0].id) : null;

    const { rows: donationRows } = await connection.query<{ id: number }>(
      `INSERT INTO donations (
        campaign_id, method_id, supporter_id, amount, donation_type,
        payment_status, attribution_code, notes
      ) VALUES ($1, $2, $3, $4, 'virtual', 'pending', $5, $6)
      RETURNING id`,
      [
        campaignId,
        methodId,
        supporterId,
        donationAmount,
        typeof attributionCode === "string" ? attributionCode : null,
        isAnonymous ? "anonymous" : null,
      ],
    );
    const donationId = donationRows[0].id;

    const frontend = resolveFrontendBaseUrl();
    const nonprofitName = String(campaign.organization_name || "the nonprofit");
    const campaignName = String(campaign.campaign_name || "campaign");
    const amountCents = Math.round(donationAmount * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: normalizedEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Donation to ${nonprofitName}`,
              description: `Online donation for ${campaignName}`,
            },
          },
        },
      ],
      success_url: `${frontend}/campaign/${encodeURIComponent(slug)}?donation=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/campaign/${encodeURIComponent(slug)}?donation=cancelled`,
      metadata: {
        donationId: String(donationId),
        campaignId: String(campaignId),
        campaignSlug: slug,
        anonymous: isAnonymous ? "1" : "0",
      },
      payment_intent_data: {
        metadata: {
          donationId: String(donationId),
          campaignId: String(campaignId),
        },
      },
    });

    if (!session.url) {
      await connection.query("ROLLBACK");
      res.status(502).json({ error: "Stripe did not return a checkout URL" });
      return;
    }

    await connection.query(
      `UPDATE donations SET stripe_checkout_session_id = $1 WHERE id = $2`,
      [session.id, donationId],
    );

    await connection.query("COMMIT");

    res.status(201).json({
      url: session.url,
      sessionId: session.id,
      donationId,
      publishableKey: config.stripe.publishableKey,
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error("Stripe checkout failed:", err);
    res.status(500).json({ error: "Failed to start Stripe checkout" });
  } finally {
    connection.release();
  }
});

/**
 * GET /:slug/donations/confirm-checkout?session_id=
 * Completes a paid session if webhook has not run yet (idempotent).
 */
stripeCheckoutRouter.get("/:slug/donations/confirm-checkout", async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    res.status(503).json({ error: "Stripe is not configured" });
    return;
  }

  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id.trim() : "";
  if (!sessionId.startsWith("cs_")) {
    res.status(400).json({ error: "Valid session_id is required" });
    return;
  }

  try {
    const { rows: campaigns } = await pool.query<QueryResultRow>(
      `SELECT id, slug FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.campaignId && Number(session.metadata.campaignId) !== campaignId) {
      res.status(400).json({ error: "Session does not belong to this campaign" });
      return;
    }
    if (session.payment_status !== "paid" && session.status !== "complete") {
      res.status(402).json({ error: "Payment not completed", paymentStatus: session.payment_status });
      return;
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    const result = await completeStripeDonationBySession(sessionId, paymentIntentId);
    if (!result.found) {
      res.status(404).json({ error: "Donation not found for this session" });
      return;
    }

    const { rows: updated } = await pool.query<QueryResultRow>(
      "SELECT raised FROM campaigns WHERE id = $1",
      [campaignId],
    );

    res.json({
      success: true,
      amount: result.amount,
      raised: Number(updated[0]?.raised ?? 0),
      alreadyCompleted: Boolean(result.alreadyCompleted) || !result.completed,
    });
  } catch (err) {
    console.error("confirm-checkout failed:", err);
    res.status(500).json({ error: "Failed to confirm donation" });
  }
});

/**
 * Stripe webhook handler — must receive raw Buffer body.
 * Method: POST /api/stripe/webhook
 */
export async function stripeWebhookHandler(req: Request, res: Response) {
  const stripe = getStripe();
  const webhookSecret = config.stripe.webhookSecret;

  if (!stripe) {
    res.status(503).json({ error: "Stripe is not configured" });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || typeof signature !== "string") {
    res.status(400).json({ error: "Missing Stripe-Signature header" });
    return;
  }

  let event;
  try {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(400).json({
        error: "Webhook requires raw body. Check mount order (raw before express.json).",
      });
      return;
    }
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } else {
      // Dev fallback when STRIPE_WEBHOOK_SECRET is unset — verify signature skipped.
      console.warn(
        "[stripe] STRIPE_WEBHOOK_SECRET unset — parsing webhook JSON without signature verify",
      );
      event = JSON.parse(rawBody.toString("utf8"));
    }
  } catch (err) {
    console.error("Stripe webhook signature verify failed:", err);
    res.status(400).json({ error: "Invalid webhook signature" });
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id: string;
        payment_status?: string;
        payment_intent?: string | { id: string } | null;
      };
      if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null;
        await completeStripeDonationBySession(session.id, paymentIntentId);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
}
