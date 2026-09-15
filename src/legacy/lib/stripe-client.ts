/**
 * Stripe SDK client for online (virtual) donations.
 *
 * Purpose: Lazy-init Stripe from env. Secret key never leaves the server.
 * Inputs: config.stripe.secretKey
 * Outputs: Stripe instance, or null when not configured
 *
 * Changelog: Pass 2 — Stripe online donation integration.
 */
import Stripe from "stripe";
import { config } from "../config";

let cached: Stripe | null | undefined;

/**
 * Returns a Stripe client when STRIPE_SECRET_KEY is set; otherwise null.
 * Inputs: none (reads config)
 * Outputs: Stripe | null
 */
export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = config.stripe.secretKey;
  if (!key) {
    cached = null;
    return cached;
  }
  cached = new Stripe(key, {
    apiVersion: "2025-02-24.acacia",
  });
  return cached;
}

/**
 * True when secret + publishable keys are present.
 * Inputs: none
 * Outputs: boolean
 */
export function isStripeConfigured(): boolean {
  return Boolean(config.stripe.secretKey && config.stripe.publishableKey);
}
