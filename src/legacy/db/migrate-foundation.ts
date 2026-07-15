import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [table, column],
  );
  return (rowCount ?? 0) > 0;
}

const PROFILE_ALTERATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "nonprofits",
    column: "facebook_url",
    ddl: "ALTER TABLE nonprofits ADD COLUMN facebook_url VARCHAR(512)",
  },
  {
    table: "nonprofits",
    column: "instagram_url",
    ddl: "ALTER TABLE nonprofits ADD COLUMN instagram_url VARCHAR(512)",
  },
  {
    table: "nonprofits",
    column: "linkedin_url",
    ddl: "ALTER TABLE nonprofits ADD COLUMN linkedin_url VARCHAR(512)",
  },
  {
    table: "nonprofits",
    column: "tiktok_url",
    ddl: "ALTER TABLE nonprofits ADD COLUMN tiktok_url VARCHAR(512)",
  },
  {
    table: "nonprofits",
    column: "youtube_url",
    ddl: "ALTER TABLE nonprofits ADD COLUMN youtube_url VARCHAR(512)",
  },
  {
    table: "nonprofits",
    column: "profile_status",
    ddl: `ALTER TABLE nonprofits
      ADD COLUMN profile_status VARCHAR(20) NOT NULL DEFAULT 'preloaded'
      CHECK (profile_status IN ('preloaded', 'invited', 'claimed', 'verified', 'active', 'inactive'))`,
  },
  {
    table: "nonprofits",
    column: "claimed_by_user_id",
    ddl: "ALTER TABLE nonprofits ADD COLUMN claimed_by_user_id INTEGER",
  },
  {
    table: "nonprofits",
    column: "claim_date",
    ddl: "ALTER TABLE nonprofits ADD COLUMN claim_date TIMESTAMP",
  },
  {
    table: "nonprofits",
    column: "verification_date",
    ddl: "ALTER TABLE nonprofits ADD COLUMN verification_date TIMESTAMP",
  },
  {
    table: "businesses",
    column: "facebook_url",
    ddl: "ALTER TABLE businesses ADD COLUMN facebook_url VARCHAR(512)",
  },
  {
    table: "businesses",
    column: "instagram_url",
    ddl: "ALTER TABLE businesses ADD COLUMN instagram_url VARCHAR(512)",
  },
  {
    table: "businesses",
    column: "linkedin_url",
    ddl: "ALTER TABLE businesses ADD COLUMN linkedin_url VARCHAR(512)",
  },
  {
    table: "businesses",
    column: "tiktok_url",
    ddl: "ALTER TABLE businesses ADD COLUMN tiktok_url VARCHAR(512)",
  },
  {
    table: "businesses",
    column: "profile_status",
    ddl: `ALTER TABLE businesses
      ADD COLUMN profile_status VARCHAR(30) NOT NULL DEFAULT 'preloaded'
      CHECK (profile_status IN ('preloaded', 'invited', 'claimed', 'verified', 'pending_onboarding', 'active', 'inactive'))`,
  },
  {
    table: "businesses",
    column: "claimed_by_user_id",
    ddl: "ALTER TABLE businesses ADD COLUMN claimed_by_user_id INTEGER",
  },
  {
    table: "businesses",
    column: "claim_date",
    ddl: "ALTER TABLE businesses ADD COLUMN claim_date TIMESTAMP",
  },
  {
    table: "businesses",
    column: "verification_date",
    ddl: "ALTER TABLE businesses ADD COLUMN verification_date TIMESTAMP",
  },
  {
    table: "campaigns",
    column: "created_by_user_id",
    ddl: "ALTER TABLE campaigns ADD COLUMN created_by_user_id INTEGER",
  },
];

async function applyProfileAlterations() {
  for (const { table, column, ddl } of PROFILE_ALTERATIONS) {
    if (await columnExists(table, column)) continue;
    await pool.query(ddl);
    console.log(`Added ${table}.${column}`);
  }

  await pool.query(
    `UPDATE nonprofits SET profile_status = 'verified'
     WHERE verification_status = 'verified' AND profile_status = 'preloaded'`,
  );
  await pool.query(
    `UPDATE nonprofits SET profile_status = 'claimed'
     WHERE claim_status = 'claimed' AND profile_status = 'preloaded'`,
  );
  await pool.query(
    `UPDATE businesses SET profile_status = 'active'
     WHERE business_status = 'active' AND profile_status = 'preloaded'`,
  );
  await pool.query(
    `UPDATE businesses SET profile_status = 'invited'
     WHERE business_status = 'invited' AND profile_status = 'preloaded'`,
  );
}

export async function migrateFoundation(options: DbTaskOptions = {}) {
  const schema = fs.readFileSync(path.join(__dirname, "schema-postgresql.sql"), "utf-8");
  await pool.query(schema);
  await applyProfileAlterations();

  console.log("ForkUp foundation schema applied (users, donations, imports, profile fields).");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateFoundation().catch((err) => {
    console.error("Foundation migration failed:", err);
    process.exit(1);
  });
}
