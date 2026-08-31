import { runSettlementPipeline, settlementEngineSettings } from "./settlement-engine";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * In-process settlement worker (Nest/Express equivalent of ForkUpSettlementEngine Worker).
 */
export function startSettlementWorker(): void {
  const settings = settlementEngineSettings();
  if (!settings.enabled) {
    console.log("[settlement-engine] Worker disabled (SETTLEMENT_ENGINE_ENABLED=false).");
    return;
  }
  if (timer) return;

  const intervalMs = Math.max(settings.intervalMinutes, 1) * 60 * 1000;
  console.log(
    `[settlement-engine] Worker started. Interval: ${settings.intervalMinutes} minutes. Grace: ${settings.gracePeriodDays} days.`,
  );

  const tick = async () => {
    if (running) {
      console.log("[settlement-engine] Previous cycle still running; skipping.");
      return;
    }
    running = true;
    try {
      console.log(`[settlement-engine] Cycle starting at ${new Date().toISOString()}`);
      const result = await runSettlementPipeline();
      console.log(
        `[settlement-engine] Cycle done. closed=${result.closed} frozen=${result.frozen} snapshots=${result.snapshots} emailed=${result.emailed}`,
      );
      if (result.errors.length) {
        console.error("[settlement-engine] Cycle errors:", result.errors.join("; "));
      }
    } catch (err) {
      console.error("[settlement-engine] Unhandled cycle error:", err);
    } finally {
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
