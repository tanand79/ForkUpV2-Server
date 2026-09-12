import pg from "pg";
import fs from "fs";
function loadEnv(p){ if(!fs.existsSync(p))return; for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){ if(!line||line.trim().startsWith("#"))continue; const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if(m&&!(m[1] in process.env)) process.env[m[1]]=m[2]; } }
loadEnv(".env");
const out = process.argv[2];
const which = process.argv[3] || "local";
let url = which === "rds" ? process.env.DATABASE_URL_PRODUCTION : (process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL);
if(!url) throw new Error("no url for "+which);
if(which==="rds" && !/\/forkupv2(\?|$)/.test(url)) url = url.replace(/\/([^/?]+)(\?|$)/, "/forkupv2$2");
const useSsl = /rds\.amazonaws\.com/i.test(url) || /[?&]ssl=true/i.test(url);
const pool = new pg.Pool({
  connectionString: url.replace(/[?&]ssl=(true|false)/ig, "").replace(/[?&]$/,""),
  ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" ? false : false } : undefined,
});
// Always rejectUnauthorized false for RDS schema dump
if (useSsl) pool.options.ssl = { rejectUnauthorized: false };
const { rows } = await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
await pool.end();
const map = {};
for (const r of rows) {
  if (!map[r.table_name]) map[r.table_name] = {};
  map[r.table_name][r.column_name] = r.data_type;
}
fs.writeFileSync(out, JSON.stringify({ host: (url.match(/@([^/?]+)/)||[])[1], db: (url.match(/\/([^/?]+)(\?|$)/)||[])[1], tables: map }, null, 2));
console.log("wrote", out, "tables", Object.keys(map).length, "cols", rows.length);
