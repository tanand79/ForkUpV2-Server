"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSettlementWorker = startSettlementWorker;
const settlement_engine_1 = require("./settlement-engine");
let timer = null;
let running = false;
function startSettlementWorker() {
    const settings = (0, settlement_engine_1.settlementEngineSettings)();
    if (!settings.enabled) {
        console.log("[settlement-engine] Worker disabled (SETTLEMENT_ENGINE_ENABLED=false).");
        return;
    }
    if (timer)
        return;
    const intervalMs = Math.max(settings.intervalMinutes, 1) * 60 * 1000;
    console.log(`[settlement-engine] Worker started. Interval: ${settings.intervalMinutes} minutes. Grace: ${settings.gracePeriodDays} days.`);
    const tick = async () => {
        if (running) {
            console.log("[settlement-engine] Previous cycle still running; skipping.");
            return;
        }
        running = true;
        try {
            console.log(`[settlement-engine] Cycle starting at ${new Date().toISOString()}`);
            const result = await (0, settlement_engine_1.runSettlementPipeline)();
            console.log(`[settlement-engine] Cycle done. closed=${result.closed} frozen=${result.frozen} snapshots=${result.snapshots} emailed=${result.emailed}`);
            if (result.errors.length) {
                console.error("[settlement-engine] Cycle errors:", result.errors.join("; "));
            }
        }
        catch (err) {
            console.error("[settlement-engine] Unhandled cycle error:", err);
        }
        finally {
            running = false;
        }
    };
    setTimeout(() => {
        void tick();
    }, 5000);
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
}
//# sourceMappingURL=settlement-worker.js.map