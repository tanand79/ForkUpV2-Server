"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("../src/legacy/db/pool");
async function main() {
    const r = await pool_1.pool.query("SELECT slug, campaign_name, campaign_status FROM campaigns ORDER BY id");
    console.log(JSON.stringify(r.rows, null, 2));
    console.log("count", r.rowCount);
    await pool_1.pool.end();
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=list-campaigns-temp.js.map