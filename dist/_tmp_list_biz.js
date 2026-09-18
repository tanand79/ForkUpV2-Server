"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const pg_1 = require("pg");
async function main() {
    const pool = new pg_1.Pool({
        connectionString: process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL,
    });
    const { rows } = await pool.query(`SELECT id, business_name, slug, contact_email, website
     FROM businesses
     ORDER BY id DESC
     LIMIT 40`);
    console.log(rows);
    await pool.end();
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=_tmp_list_biz.js.map