import dotenv from "dotenv";
import path from "path";

const envDir = process.cwd();

function loadEnvFile(filename: string) {
  dotenv.config({
    path: path.join(envDir, filename),
    override: false,
  });
}

loadEnvFile(".env");
if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
  loadEnvFile(".env.production");
}

export type DatabaseTarget = "local" | "production";

function resolveDatabaseTarget(): DatabaseTarget {
  const explicit = (process.env.DATABASE_TARGET ?? "").trim().toLowerCase();
  const nodeEnvProd = (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  if (explicit === "production") return "production";
  if (explicit === "local") {
    if (nodeEnvProd) {
      console.warn(
        "DATABASE_TARGET=local while NODE_ENV=production — registration and auth will fail unless a local PostgreSQL database exists. Set DATABASE_TARGET=production on the server.",
      );
    }
    return "local";
  }
  return nodeEnvProd ? "production" : "local";
}

const nodeEnv = process.env.NODE_ENV || "development";
const databaseTarget = resolveDatabaseTarget();

function resolveDatabaseUrl(): string {
  const selected =
    (databaseTarget === "production"
      ? process.env.DATABASE_URL_PRODUCTION?.trim()
      : process.env.DATABASE_URL_LOCAL?.trim()) ||
    process.env.DATABASE_URL?.trim();

  if (!selected) {
    throw new Error(
      `Missing database URL for target "${databaseTarget}". Set DATABASE_URL_${databaseTarget.toUpperCase()} or DATABASE_URL in api/.env`,
    );
  }

  return selected;
}

function resolveCorsOrigins(): string | string[] {
  const parts = [process.env.CORS_ORIGIN, process.env.FRONTEND_URL]
    .filter(Boolean)
    .flatMap((v) => v!.split(","))
    .map((o) => o.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length === 0) {
    if (nodeEnv === "production") {
      console.warn(
        "CORS_ORIGIN is not set — browser requests from your frontend will be blocked. Set CORS_ORIGIN or FRONTEND_URL.",
      );
    }
    return ["http://localhost:3000", "http://localhost:8080"];
  }
  return unique.length === 1 ? unique[0] : unique;
}

export const config = {
  nodeEnv,
  databaseTarget,
  port: Number(process.env.PORT || 3001),
  get databaseUrl() {
    const url = resolveDatabaseUrl();
    process.env.DATABASE_URL = url;
    return url;
  },
  corsOrigin: resolveCorsOrigins(),
  /** Optional shared secret gating the automated success-engine sweep endpoint. */
  get automationSecret(): string {
    return (process.env.AUTOMATION_SECRET ?? "").trim();
  },
};
