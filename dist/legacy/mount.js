"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mountLegacyApi = mountLegacyApi;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const builder_1 = require("./routes/builder");
const business_1 = require("./routes/business");
const location_ach_1 = require("./routes/location-ach");
const campaigns_1 = require("./routes/campaigns");
const campaign_images_1 = require("./routes/campaign-images");
const manage_1 = require("./routes/manage");
const improve_story_1 = require("./routes/improve-story");
const generate_campaign_draft_1 = require("./routes/generate-campaign-draft");
const suggest_campaign_goal_1 = require("./routes/suggest-campaign-goal");
const generate_organization_draft_1 = require("./routes/generate-organization-draft");
const generate_business_draft_1 = require("./routes/generate-business-draft");
const receipts_1 = require("./routes/receipts");
const uploads_1 = require("./routes/uploads");
const auth_1 = require("./routes/auth");
const ai_1 = require("./routes/ai");
const nonprofit_ach_1 = require("./routes/nonprofit-ach");
const settlement_ach_approval_1 = require("./routes/settlement-ach-approval");
const us_nonprofit_suggest_1 = require("./routes/us-nonprofit-suggest");
const profiles_1 = require("./routes/profiles");
const library_1 = require("./routes/library");
const superadmin_1 = require("./routes/superadmin");
const campaign_ai_1 = require("./routes/campaign-ai");
const ai_campaign_flow_1 = require("./routes/ai-campaign-flow");
const fundraiser_1 = require("./routes/fundraiser");
const support_1 = require("./routes/support");
const guest_campaign_claim_1 = require("./routes/guest-campaign-claim");
const receipts_2 = require("./lib/receipts");
const pool_1 = require("./db/pool");
function mountLegacyApi(app) {
    (0, receipts_2.ensureUploadsDir)();
    app.use((0, cors_1.default)({
        origin: config_1.config.corsOrigin,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    }));
    app.use(express_1.default.json({ limit: "12mb" }));
    app.use((req, _res, next) => {
        if (req.url.length > 1 && req.url.endsWith("/")) {
            req.url = req.url.replace(/\/+(?=\?|$)/, "");
        }
        next();
    });
    app.use("/uploads", express_1.default.static(path_1.default.join(process.cwd(), "uploads")));
    app.get("/", (_req, res) => {
        res.json({ status: "ok", service: "forkup-api" });
    });
    app.get("/api/health", async (_req, res) => {
        const hasDatabaseUrl = Boolean(process.env.DATABASE_URL_PRODUCTION?.trim() ||
            process.env.DATABASE_URL_LOCAL?.trim() ||
            process.env.DATABASE_URL?.trim());
        let databaseOk = false;
        let databaseError;
        if (hasDatabaseUrl) {
            try {
                await pool_1.pool.query("SELECT 1 AS ok");
                databaseOk = true;
            }
            catch (err) {
                databaseError = err instanceof Error ? err.message : String(err);
                console.error("Database health check failed:", err);
            }
        }
        res.json({
            status: databaseOk ? "ok" : hasDatabaseUrl ? "degraded" : "ok",
            env: config_1.config.nodeEnv,
            databaseTarget: config_1.config.databaseTarget,
            databaseConfigured: hasDatabaseUrl,
            databaseOk,
            ...(databaseError ? { databaseError } : {}),
        });
    });
    app.use("/api/campaigns", campaigns_1.campaignsRouter);
    app.use("/api/campaign-images", campaign_images_1.campaignImagesRouter);
    app.use("/api/builder", builder_1.builderRouter);
    app.use("/api/profiles", us_nonprofit_suggest_1.usNonprofitSuggestRouter);
    app.use("/api/profiles", nonprofit_ach_1.nonprofitAchRouter);
    app.use("/api/profiles", profiles_1.profilesRouter);
    app.use("/api/library", library_1.libraryRouter);
    app.use("/api/auth", auth_1.authRouter);
    app.use("/api/ai", ai_1.aiRouter);
    app.use("/api/superadmin", superadmin_1.superadminRouter);
    app.use("/api/business", business_1.businessRouter);
    app.use("/api/business", location_ach_1.locationAchRouter);
    app.use("/api", receipts_1.receiptsRouter);
    app.use("/api/uploads", uploads_1.uploadsRouter);
    app.use("/api", improve_story_1.improveStoryRouter);
    app.use("/api", generate_campaign_draft_1.generateCampaignDraftRouter);
    app.use("/api", suggest_campaign_goal_1.suggestCampaignGoalRouter);
    app.use("/api", generate_organization_draft_1.generateOrganizationDraftRouter);
    app.use("/api", generate_business_draft_1.generateBusinessDraftRouter);
    app.use("/api/campaign-ai", campaign_ai_1.campaignAiRouter);
    app.use("/api/ai-campaign-flow", ai_campaign_flow_1.aiCampaignFlowRouter);
    app.use("/api/fundraiser", fundraiser_1.fundraiserRouter);
    app.use("/api/support", support_1.supportRouter);
    app.use("/api/guest-campaign-claim", guest_campaign_claim_1.guestCampaignClaimRouter);
    app.use("/api/manage", manage_1.manageRouter);
    app.use("/api", settlement_ach_approval_1.settlementAchApprovalRouter);
}
//# sourceMappingURL=mount.js.map