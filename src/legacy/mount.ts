import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { config } from "./config";
import { builderRouter } from "./routes/builder";
import { businessRouter } from "./routes/business";
import { locationAchRouter } from "./routes/location-ach";
import { campaignsRouter } from "./routes/campaigns";
import { campaignImagesRouter } from "./routes/campaign-images";
import { manageRouter } from "./routes/manage";
import { improveStoryRouter } from "./routes/improve-story";
import { generateCampaignDraftRouter } from "./routes/generate-campaign-draft";
import { suggestCampaignGoalRouter } from "./routes/suggest-campaign-goal";
import { generateOrganizationDraftRouter } from "./routes/generate-organization-draft";
import { generateBusinessDraftRouter } from "./routes/generate-business-draft";
import { findBusinessProfileRouter } from "./routes/find-business-profile";
import { businessVenueImagesRouter } from "./routes/business-venue-images";
import { businessVenueGalleryRouter } from "./routes/business-venue-gallery";
import { businessVenueLinksRouter } from "./routes/business-venue-links";
import { venuePhotoProxyRouter } from "./routes/venue-photo-proxy";
import { receiptsRouter } from "./routes/receipts";
import { uploadsRouter } from "./routes/uploads";
import { authRouter } from "./routes/auth";
import { aiRouter } from "./routes/ai";
import { nonprofitAchRouter } from "./routes/nonprofit-ach";
import { settlementAchApprovalRouter } from "./routes/settlement-ach-approval";
import { usNonprofitSuggestRouter } from "./routes/us-nonprofit-suggest";
import { profilesRouter } from "./routes/profiles";
import { libraryRouter } from "./routes/library";
import { superadminRouter } from "./routes/superadmin";
import { campaignAiRouter } from "./routes/campaign-ai";
import { aiCampaignFlowRouter } from "./routes/ai-campaign-flow";
import { fundraiserRouter } from "./routes/fundraiser";
import { supportRouter } from "./routes/support";
import { emailTemplatesRouter } from "./routes/email-templates";
import { guestCampaignClaimRouter } from "./routes/guest-campaign-claim";
import { guestBusinessClaimRouter } from "./routes/guest-business-claim";
import { businessPostStartRouter } from "./routes/business-post-start";
import {
  campaignPartnerJoinBusinessRouter,
  campaignPartnerJoinManageRouter,
} from "./routes/campaign-partner-join-requests";
import {
  stripeCheckoutRouter,
  stripeConfigRouter,
  stripeWebhookHandler,
} from "./routes/stripe-donations";
import { ensureUploadsDir } from "./lib/receipts";
import { pool } from "./db/pool";

export function mountLegacyApi(app: Express) {
  ensureUploadsDir();

  app.use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Stripe-Signature"],
    }),
  );

  // Stripe webhooks require the raw body for signature verification — before JSON parser.
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    (req, res) => {
      void stripeWebhookHandler(req, res);
    },
  );

  app.use(express.json({ limit: "12mb" }));
  // Next.js `trailingSlash` can append `/` to proxied API calls — normalize before routing.
  app.use((req, _res, next) => {
    if (req.url.length > 1 && req.url.endsWith("/")) {
      req.url = req.url.replace(/\/+(?=\?|$)/, "");
    }
    next();
  });
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  app.get("/", (_req, res) => {
    res.json({ status: "ok", service: "forkup-api" });
  });

  app.get("/api/health", async (_req, res) => {
    const hasDatabaseUrl = Boolean(
      process.env.DATABASE_URL_PRODUCTION?.trim() ||
        process.env.DATABASE_URL_LOCAL?.trim() ||
        process.env.DATABASE_URL?.trim(),
    );

    let databaseOk = false;
    let databaseError: string | undefined;
    if (hasDatabaseUrl) {
      try {
        await pool.query("SELECT 1 AS ok");
        databaseOk = true;
      } catch (err) {
        databaseError = err instanceof Error ? err.message : String(err);
        console.error("Database health check failed:", err);
      }
    }

    res.json({
      status: databaseOk ? "ok" : hasDatabaseUrl ? "degraded" : "ok",
      env: config.nodeEnv,
      databaseTarget: config.databaseTarget,
      databaseConfigured: hasDatabaseUrl,
      databaseOk,
      ...(databaseError ? { databaseError } : {}),
    });
  });

  app.use("/api/stripe", stripeConfigRouter);
  app.use("/api/campaigns", stripeCheckoutRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/campaign-images", campaignImagesRouter);
  app.use("/api/builder", builderRouter);
  // Mount before profilesRouter so /nonprofits/us-suggest is not captured by /nonprofits/:slug.
  app.use("/api/profiles", usNonprofitSuggestRouter);
  app.use("/api/profiles", nonprofitAchRouter);
  app.use("/api/profiles", profilesRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/superadmin", superadminRouter);
  app.use("/api/business", businessRouter);
  app.use("/api/business", locationAchRouter);
  /** Business → NPO: request to join an existing public campaign. */
  app.use("/api/business", campaignPartnerJoinBusinessRouter);
  app.use("/api", receiptsRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api", improveStoryRouter);
  app.use("/api", generateCampaignDraftRouter);
  app.use("/api", suggestCampaignGoalRouter);
  app.use("/api", generateOrganizationDraftRouter);
  app.use("/api", generateBusinessDraftRouter);
  /** Pass D1: name → website/location/photos for restaurant & local Join Us. */
  app.use("/api", findBusinessProfileRouter);
  /** Venue gallery refresh (Resy + site photos) for join profile. */
  app.use("/api", businessVenueImagesRouter);
  /** Business-owned gallery uploads + cover selection (durable). */
  app.use("/api", businessVenueGalleryRouter);
  /** Business-owned social / contact link edits (durable overwrite). */
  app.use("/api", businessVenueLinksRouter);
  /** Same-origin proxy for Resy CDN gallery images. */
  app.use("/api", venuePhotoProxyRouter);
  app.use("/api/campaign-ai", campaignAiRouter);
  app.use("/api/ai-campaign-flow", aiCampaignFlowRouter);
  app.use("/api/fundraiser", fundraiserRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/email-templates", emailTemplatesRouter);
  app.use("/api/guest-campaign-claim", guestCampaignClaimRouter);
  /** Guest restaurant/local claim link (email token → attach organization_users). */
  app.use("/api/guest-business-claim", guestBusinessClaimRouter);
  app.use("/api", businessPostStartRouter);
  app.use("/api/manage", manageRouter);
  /** NPO: list / accept / decline partner join requests. */
  app.use("/api/manage", campaignPartnerJoinManageRouter);
  app.use("/api", settlementAchApprovalRouter);
}
