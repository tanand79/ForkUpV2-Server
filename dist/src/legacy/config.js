"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const envDir = process.cwd();
function loadEnvFile(filename) {
    dotenv_1.default.config({
        path: path_1.default.join(envDir, filename),
        override: false,
    });
}
loadEnvFile(".env");
if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    loadEnvFile(".env.production");
}
function resolveDatabaseTarget() {
    const explicit = (process.env.DATABASE_TARGET ?? "").trim().toLowerCase();
    const nodeEnvProd = (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
    if (explicit === "production")
        return "production";
    if (explicit === "local") {
        if (nodeEnvProd) {
            console.warn("DATABASE_TARGET=local while NODE_ENV=production — registration and auth will fail unless a local PostgreSQL database exists. Set DATABASE_TARGET=production on the server.");
        }
        return "local";
    }
    return nodeEnvProd ? "production" : "local";
}
const nodeEnv = process.env.NODE_ENV || "development";
const databaseTarget = resolveDatabaseTarget();
function resolveDatabaseUrl() {
    const selected = (databaseTarget === "production"
        ? process.env.DATABASE_URL_PRODUCTION?.trim()
        : process.env.DATABASE_URL_LOCAL?.trim()) ||
        process.env.DATABASE_URL?.trim();
    if (!selected) {
        throw new Error(`Missing database URL for target "${databaseTarget}". Set DATABASE_URL_${databaseTarget.toUpperCase()} or DATABASE_URL in api/.env`);
    }
    return selected;
}
function resolveCorsOrigins() {
    const parts = [process.env.CORS_ORIGIN, process.env.FRONTEND_URL]
        .filter(Boolean)
        .flatMap((v) => v.split(","))
        .map((o) => o.trim())
        .filter(Boolean);
    const unique = [...new Set(parts)];
    if (unique.length === 0) {
        if (nodeEnv === "production") {
            console.warn("CORS_ORIGIN is not set — browser requests from your frontend will be blocked. Set CORS_ORIGIN or FRONTEND_URL.");
        }
        return ["http://localhost:3000", "http://localhost:8080"];
    }
    return unique.length === 1 ? unique[0] : unique;
}
exports.config = {
    nodeEnv,
    databaseTarget,
    port: Number(process.env.PORT || 3001),
    get databaseUrl() {
        const url = resolveDatabaseUrl();
        process.env.DATABASE_URL = url;
        return url;
    },
    corsOrigin: resolveCorsOrigins(),
    get automationSecret() {
        return (process.env.AUTOMATION_SECRET ?? "").trim();
    },
    s3: {
        region: process.env.AWS_REGION?.trim() || "us-east-1",
        bucket: process.env.S3_BUCKET?.trim() || "",
        presignTtlSeconds: Number(process.env.S3_PRESIGN_TTL_SECONDS || 86400),
    },
    mindee: {
        get apiKey() {
            return (process.env.MINDEE_API_KEY ?? "").trim();
        },
        get modelId() {
            return (process.env.MINDEE_MODEL_ID ?? "").trim();
        },
        get apiUrl() {
            return (process.env.MINDEE_API_URL?.trim() ||
                "https://api.mindee.net/v1/products/mindee/expense_receipts/v5/predict");
        },
        get v2EnqueueUrl() {
            return (process.env.MINDEE_V2_ENQUEUE_URL?.trim() ||
                "https://api-v2.mindee.net/v2/inferences/enqueue");
        },
    },
    get settlementEngineEnabled() {
        const v = (process.env.SETTLEMENT_ENGINE_ENABLED ?? "true").trim().toLowerCase();
        return v !== "false" && v !== "0";
    },
    achEncryption: {
        get key() {
            return (process.env.ACH_ENCRYPTION_KEY ?? "").trim();
        },
        get iv() {
            return (process.env.ACH_ENCRYPTION_IV ?? "").trim();
        },
    },
    stripe: {
        get secretKey() {
            return (process.env.STRIPE_SECRET_KEY ?? "").trim();
        },
        get publishableKey() {
            return (process.env.STRIPE_PUBLISHABLE_KEY ?? "").trim();
        },
        get webhookSecret() {
            return (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
        },
    },
};
//# sourceMappingURL=config.js.map