import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { config } from "./config";
import { builderRouter } from "./routes/builder";
import { businessRouter } from "./routes/business";
import { campaignsRouter } from "./routes/campaigns";
import { manageRouter } from "./routes/manage";
import { improveStoryRouter } from "./routes/improve-story";
import { receiptsRouter } from "./routes/receipts";
import { authRouter } from "./routes/auth";
import { profilesRouter } from "./routes/profiles";
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
  app.use("/api/builder", builderRouter);
  app.use("/api/profiles", profilesRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/business", businessRouter);
  app.use("/api", receiptsRouter);
  app.use("/api", improveStoryRouter);
  app.use("/api/manage", manageRouter);
}
