"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("./pool");
async function main() {
    const nonprofits = await pool_1.pool.query("SELECT id, organization_name, contact_email, slug FROM nonprofits ORDER BY id");
    const businesses = await pool_1.pool.query("SELECT id, business_name, contact_email, slug FROM businesses ORDER BY id");
    const users = await pool_1.pool.query("SELECT id, email, username, is_platform_admin FROM users ORDER BY id");
    console.log("nonprofits:", nonprofits.rowCount);
    console.log(JSON.stringify(nonprofits.rows, null, 2));
    console.log("businesses:", businesses.rowCount);
    console.log(JSON.stringify(businesses.rows, null, 2));
    console.log("users:", users.rowCount);
    console.log(JSON.stringify(users.rows, null, 2));
    await pool_1.pool.end();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=inspect-org-counts.js.map