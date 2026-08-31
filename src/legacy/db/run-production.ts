/**
 * Run database tasks against the production PostgreSQL database.
 * Sets NODE_ENV and DATABASE_TARGET before any pool/config imports.
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

const task = (process.argv[2] ?? "").toLowerCase();

const tasks: Record<string, string> = {
  migrate: "migrate",
  push: "migrate",
  baseline: "migrate",
  patch: "patch",
  foundation: "foundation",
  seed: "seed",
  setup: "setup",
  deploy: "setup",
};

const resolved = tasks[task];
if (!resolved) {
  console.error(
    "Usage: tsx src/db/run-production.ts <task>\n" +
      "Tasks: migrate | push | baseline | patch | seed | setup | deploy",
  );
  process.exit(1);
}

async function run() {
  const { config } = await import("../config");
  const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
  console.log(`Production DB task: ${task} -> ${resolved}`);
  console.log(`Database target: ${config.databaseTarget}`);
  console.log(`Connection: ${safeUrl}`);

  const keepPoolOpen = resolved === "setup";

  if (resolved === "migrate" || resolved === "setup") {
    const { migrate } = await import("./migrate");
    await migrate({ closePool: !keepPoolOpen });
  }

  if (resolved === "patch") {
    const { migratePatch } = await import("./migrate-patch");
    await migratePatch();
  }

  /**
   * Additive invite-status columns/indexes for legacy production DBs that created
   * business_invitations before business_id and readiness fields existed.
   * Safe to re-run (IF NOT EXISTS / constraint guards).
   */
  if (resolved === "setup") {
    const { migrateBusinessInviteStatusFields } = await import(
      "./migrate-business-invite-status-fields"
    );
    await migrateBusinessInviteStatusFields({ closePool: false });
    const { migrateSettlementEngine } = await import("./migrate-settlement-engine");
    await migrateSettlementEngine({ closePool: false });
  }

  if (resolved === "foundation" || resolved === "setup") {
    const { migrateFoundation } = await import("./migrate-foundation");
    await migrateFoundation({ closePool: !keepPoolOpen });
  }

  if (resolved === "seed" || resolved === "setup") {
    const { seed } = await import("./seed");
    await seed();
  }
}

run().catch((err) => {
  console.error("Production DB task failed:", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("password authentication failed") ||
    msg.includes("no pg_hba.conf entry") ||
    msg.includes("ECONNREFUSED")
  ) {
    console.error(
      "\nTip: verify the PostgreSQL hostname, credentials, SSL requirements, and network allowlist in DATABASE_URL_PRODUCTION.",
    );
  }
  process.exit(1);
});
