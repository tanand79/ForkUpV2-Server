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
import { receiptsRouter } from "./routes/receipts";
import { uploadsRouter } from "./routes/uploads";
import { authRouter } from "./routes/auth";
import { profilesRouter } from "./routes/profiles";
import { usNonprofitSuggestRouter } from "./routes/us-nonprofit-suggest";
import { libraryRouter } from "./routes/library";
import { superadminRouter } from "./routes/superadmin";
import { campaignAiRouter } from "./routes/campaign-ai";
import { aiCampaignFlowRouter } from "./routes/ai-campaign-flow";
import { fundraiserRouter } from "./routes/fundraiser";
import { supportRouter } from "./routes/support";
import { ensureUploadsDir } from "./lib/receipts";
import { pool } from "./db/pool";

export function mountLegacyApi(app: Express) {
  ensureUploadsDir();

  app.use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
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

  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/campaign-images", campaignImagesRouter);
  app.use("/api/builder", builderRouter);
  // Mount before profilesRouter so /nonprofits/us-suggest is not captured by /nonprofits/:slug.
  app.use("/api/profiles", usNonprofitSuggestRouter);
  app.use("/api/profiles", profilesRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/superadmin", superadminRouter);
  app.use("/api/business", businessRouter);
  app.use("/api/business", locationAchRouter);
  app.use("/api", receiptsRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api", improveStoryRouter);
  app.use("/api", generateCampaignDraftRouter);
  app.use("/api", suggestCampaignGoalRouter);
  app.use("/api", generateOrganizationDraftRouter);
  app.use("/api/campaign-ai", campaignAiRouter);
  app.use("/api/ai-campaign-flow", aiCampaignFlowRouter);
  app.use("/api/fundraiser", fundraiserRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/manage", manageRouter);
}
