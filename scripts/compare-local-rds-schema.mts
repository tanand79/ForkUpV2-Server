/**
 * Compare public schema columns: local DB vs RDS forkupv2.
 * Prints only diffs. Does not modify anything.
 */
import pg from "pg";
import fs from "fs";
import path from "path";

function loadEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

loadEnv(path.join(process.cwd(), ".env"));

async function schema(label: string, url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: /rds\.amazonaws\.com/i.test(url)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  try {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`);
    const map = new Map<string, Map<string, string>>();
    for (const r of rows) {
      if (!map.has(r.table_name)) map.set(r.table_name, new Map());
      map.get(r.table_name)!.set(r.column_name, r.data_type);
    }
    console.log(`OK ${label} tables=${map.size} cols=${rows.length}`);
    return map;
  } finally {
    await pool.end();
  }
}

const localUrl = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
let rdsUrl = process.env.DATABASE_URL_PRODUCTION;
if (!localUrl) throw new Error("missing DATABASE_URL_LOCAL");
if (!rdsUrl) throw new Error("missing DATABASE_URL_PRODUCTION");

// Compare against forkupv2 database name specifically
if (!/\/forkupv2(\?|$)/.test(rdsUrl)) {
  rdsUrl = rdsUrl.replace(/\/([^/?]+)(\?|$)/, "/forkupv2$2");
}

console.log("LOCAL", (localUrl.match(/@([^/?]+)/) || [])[1]);
console.log(
  "RDS",
  (rdsUrl.match(/@([^/?]+)/) || [])[1],
  "db=",
  (rdsUrl.match(/\/([^/?]+)(\?|$)/) || [])[1],
);

const local = await schema("local", localUrl);
const remote = await schema("rds-forkupv2", rdsUrl);

const localTables = [...local.keys()].sort();
const remoteTables = [...remote.keys()].sort();
const onlyLocal = localTables.filter((t) => !remote.has(t));
const onlyRemote = remoteTables.filter((t) => !local.has(t));
const both = localTables.filter((t) => remote.has(t));

console.log("\n=== TABLES only in LOCAL ===");
console.log(onlyLocal.length ? onlyLocal.join("\n") : "(none)");
console.log("\n=== TABLES only in RDS forkupv2 ===");
console.log(onlyRemote.length ? onlyRemote.join("\n") : "(none)");

let missingCols = 0;
let extraCols = 0;
let typeMismatches = 0;
console.log("\n=== COLUMN DIFFS (shared tables) ===");
for (const t of both) {
  const lc = local.get(t)!;
  const rc = remote.get(t)!;
  const missNames = [...lc.keys()].filter((n) => !rc.has(n));
  const extraNames = [...rc.keys()].filter((n) => !lc.has(n));
  const mismatches = [...lc.keys()]
    .filter((n) => rc.has(n) && lc.get(n) !== rc.get(n))
    .map((n) => `${n} local=${lc.get(n)} rds=${rc.get(n)}`);
  if (missNames.length || extraNames.length || mismatches.length) {
    console.log(`\n[${t}]`);
    if (missNames.length) {
      console.log("  missing on RDS:", missNames.join(", "));
      missingCols += missNames.length;
    }
    if (extraNames.length) {
      console.log("  extra on RDS:", extraNames.join(", "));
      extraCols += extraNames.length;
    }
    if (mismatches.length) {
      console.log("  type mismatch:", mismatches.join("; "));
      typeMismatches += mismatches.length;
    }
  }
}

console.log(
  `\nSUMMARY missing_on_rds=${missingCols} extra_on_rds=${extraCols} type_mismatch=${typeMismatches} only_local_tables=${onlyLocal.length} only_rds_tables=${onlyRemote.length}`,
);
if (missingCols === 0 && onlyLocal.length === 0) {
  console.log("VERDICT: RDS forkupv2 has all local tables/columns (or more).");
} else {
  console.log("VERDICT: RDS forkupv2 is missing some local schema.");
}
