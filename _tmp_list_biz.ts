import "dotenv/config";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL,
  });
  const { rows } = await pool.query(
    `SELECT id, business_name, slug, contact_email, website
     FROM businesses
     ORDER BY id DESC
     LIMIT 40`,
  );
  console.log(rows);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
