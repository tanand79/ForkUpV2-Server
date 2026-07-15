"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const __dirname = path_1.default.dirname((0, url_1.fileURLToPath)(import.meta.url));
const isDry = process.argv.includes("--dry");
async function listTableNames(query) {
    const { rows } = await query(`SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'`);
    return new Set(rows.map((r) => r.table_name));
}
async function run() {
    const { config } = await import("../config");
    const { pool } = await import("./pool");
    const safeUrl = config.databaseUrl.replace(/:([^:@/]+)@/, ":****@");
    console.log(`Mode:        ${isDry ? "DRY RUN (rollback, no changes saved)" : "APPLY (changes saved)"}`);
    console.log(`DB target:   ${config.databaseTarget}`);
    console.log(`Connection:  ${safeUrl}`);
    console.log("");
    const schema = fs_1.default.readFileSync(path_1.default.join(__dirname, "schema-postgresql.sql"), "utf-8");
    const client = await pool.connect();
    try {
        const before = await listTableNames((text) => client.query(text));
        await client.query("BEGIN");
        await client.query(schema);
        const after = await listTableNames((text) => client.query(text));
        const created = [...after].filter((t) => !before.has(t)).sort();
        if (isDry) {
            await client.query("ROLLBACK");
            console.log(created.length > 0
                ? `Would CREATE ${created.length} table(s): ${created.join(", ")}`
                : "No new tables — RDS schema already matches (nothing would change).");
            console.log("\nDry run complete. Nothing was saved to RDS.");
        }
        else {
            await client.query("COMMIT");
            console.log(created.length > 0
                ? `Created ${created.length} table(s): ${created.join(", ")}`
                : "No new tables — RDS schema already up to date.");
            console.log("\nSchema push complete.");
        }
    }
    catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
        await pool.end();
    }
}
run().catch((err) => {
    console.error("\nRDS schema push failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Missing database URL")) {
        console.error(`
How to set it (PowerShell — same window, then re-run npm):

  $env:DATABASE_URL_PRODUCTION="postgresql://USER:PASSWORD@RDS_ENDPOINT:5432/forkup?ssl=true"
  npm run db:push-rds:schema:dry

Or add this line once to Forkup-Server/.env (gitignored, never commit):

  DATABASE_URL_PRODUCTION=postgresql://USER:PASSWORD@RDS_ENDPOINT:5432/forkup?ssl=true

Replace USER / PASSWORD / RDS_ENDPOINT with your real RDS values.
URL-encode special chars in the password (@ → %40, # → %23, / → %2F).
`);
    }
    else if (msg.includes("password authentication failed") ||
        msg.includes("no pg_hba.conf entry") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("timeout")) {
        console.error("\nTip: check DATABASE_URL_PRODUCTION (host, URL-encoded password, ?ssl=true) and that the\n" +
            "RDS security group allows inbound 5432 from your current IP.");
    }
    process.exit(1);
});
//# sourceMappingURL=push-rds-schema.js.map