import pg from "pg";
import fs from "fs";

function loadEnv(p: string) {
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv(".env");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_LOCAL });
const cols = await pool.query(
  `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name='businesses'
     AND column_name IN ('tax_id','paperwork_status','paperwork_submitted_at')
   ORDER BY column_name`,
);
console.log("businesses:", JSON.stringify(cols.rows, null, 2));
const t = await pool.query(
  `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name='business_paperwork_tokens'
   ORDER BY ordinal_position`,
);
console.log("tokens:", JSON.stringify(t.rows, null, 2));
const cons = await pool.query(
  `SELECT conname, pg_get_constraintdef(oid) AS def
   FROM pg_constraint
   WHERE conrelid = 'business_paperwork_tokens'::regclass`,
);
console.log("constraints:", JSON.stringify(cons.rows, null, 2));
const idx = await pool.query(
  `SELECT indexdef FROM pg_indexes WHERE tablename='business_paperwork_tokens'`,
);
console.log("indexes:", JSON.stringify(idx.rows, null, 2));
const idCol = await pool.query(
  `SELECT column_default, is_identity, identity_generation
   FROM information_schema.columns
   WHERE table_name='business_paperwork_tokens' AND column_name='id'`,
);
console.log("id meta:", JSON.stringify(idCol.rows, null, 2));
const chk = await pool.query(
  `SELECT conname, pg_get_constraintdef(oid) AS def
   FROM pg_constraint
   WHERE conrelid = 'businesses'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%paperwork%'`,
);
console.log("businesses paperwork checks:", JSON.stringify(chk.rows, null, 2));
await pool.end();
