"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateVenueCoverUrl = migrateVenueCoverUrl;
const cli_1 = require("./cli");
const pool_1 = require("./pool");
const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS venue_cover_url VARCHAR(2048) NULL;
`;
async function migrateVenueCoverUrl(options = {}) {
    await pool_1.pool.query(SQL);
    console.log("ForkUp businesses.venue_cover_url column applied (nullable).");
    if (options.closePool !== false) {
        await pool_1.pool.end();
    }
}
if ((0, cli_1.isDirectRun)(import.meta.url)) {
    migrateVenueCoverUrl().catch((err) => {
        console.error("venue_cover_url migration failed:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=migrate-venue-cover-url.js.map