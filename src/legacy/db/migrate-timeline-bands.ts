/**
 * Additive migration: 4-band campaign timeline check + business-confirmed fields.
 *
 * Purpose: Support Healthy (30+) / Limited (21–29) / Tight (8–20) / Too Soon (0–7)
 * bands from the Campaign Timeline Check product flow, plus optional confirmation
 * form when the organizer already has a business/venue locked in.
 *
 * Adds:
 * - campaigns.business_timing_status values: tight_timeline, too_soon
 *   (keeps ok, needs_forkup_review, limited_promotion_window)
 * - campaign_methods.timing_status: same new values
 * - campaigns.confirmed_* / business_confirmed_at (nullable form fields)
 *
 * Inputs: none (uses pool / DATABASE_TARGET).
 * Outputs: CHECK + columns applied; console summary.
 *
 * Run: npx tsx src/legacy/db/migrate-timeline-bands.ts
 *   or: npm run db:timeline-bands
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const CAMPAIGN_TIMING_CONSTRAINT = "campaigns_business_timing_status_check";
const METHOD_TIMING_CONSTRAINT = "campaign_methods_timing_status_check";
const CONFIRMED_METHOD_CONSTRAINT = "campaigns_confirmed_method_check";

const TIMING_STATUS_VALUES = [
  "ok",
  "needs_forkup_review",
  "limited_promotion_window",
  "tight_timeline",
  "too_soon",
];

const CONFIRMED_COLUMNS_DDL = `
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_business_name VARCHAR(255);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_contact_name VARCHAR(255);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_contact_email VARCHAR(255);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_method VARCHAR(30);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_status VARCHAR(80);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS confirmed_notes TEXT;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS business_confirmed_at TIMESTAMP;
`;

/**
 * Returns true when the named CHECK definition already includes every required value.
 */
async function constraintAllowsAll(
  constraintName: string,
  requiredValues: string[],
): Promise<boolean> {
  const { rows } = await pool.query<{ definition: string | null }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = $1
       AND n.nspname = current_schema()`,
    [constraintName],
  );
  const def = rows[0]?.definition ?? "";
  if (!def) return false;
  return requiredValues.every((v) => new RegExp(`'${v}'`, "i").test(def));
}

/**
 * Drop + recreate a CHECK so it allows the given string list (idempotent when already OK).
 */
async function ensureStatusCheck(
  tableName: string,
  constraintName: string,
  columnName: string,
  values: string[],
): Promise<void> {
  const already = await constraintAllowsAll(constraintName, values);
  if (already) {
    console.log(`OK (already): ${constraintName} allows all band values`);
    return;
  }
  const list = values.map((v) => `'${v}'`).join(", ");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}`,
    );
    await client.query(
      `ALTER TABLE ${tableName}
       ADD CONSTRAINT ${constraintName}
       CHECK (${columnName}::text = ANY (ARRAY[${list}]::text[]))`,
    );
    await client.query("COMMIT");
    console.log(`Updated ${constraintName} → ${values.join(" | ")}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ensure confirmed_method is NULL or one of email | phone | in_person.
 */
async function ensureConfirmedMethodCheck(): Promise<void> {
  const already = await constraintAllowsAll(CONFIRMED_METHOD_CONSTRAINT, [
    "email",
    "phone",
    "in_person",
  ]);
  if (already) {
    console.log(`OK (already): ${CONFIRMED_METHOD_CONSTRAINT}`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS ${CONFIRMED_METHOD_CONSTRAINT}`,
    );
    await client.query(
      `ALTER TABLE campaigns
       ADD CONSTRAINT ${CONFIRMED_METHOD_CONSTRAINT}
       CHECK (
         confirmed_method IS NULL
         OR confirmed_method::text = ANY (ARRAY['email', 'phone', 'in_person']::text[])
       )`,
    );
    await client.query("COMMIT");
    console.log(`Added ${CONFIRMED_METHOD_CONSTRAINT}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies 4-band timing statuses + business confirmation columns.
 * Idempotent: safe to re-run.
 */
export async function migrateTimelineBands(options: DbTaskOptions = {}) {
  await pool.query(`SET lock_timeout = '15s'`);

  await ensureStatusCheck(
    "campaigns",
    CAMPAIGN_TIMING_CONSTRAINT,
    "business_timing_status",
    TIMING_STATUS_VALUES,
  );
  await ensureStatusCheck(
    "campaign_methods",
    METHOD_TIMING_CONSTRAINT,
    "timing_status",
    TIMING_STATUS_VALUES,
  );

  await pool.query(CONFIRMED_COLUMNS_DDL);
  console.log(
    "OK: campaigns.confirmed_* / business_confirmed_at columns present",
  );

  await ensureConfirmedMethodCheck();

  console.log("ForkUp timeline bands migration complete.");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateTimelineBands().catch((err) => {
    console.error("Timeline bands migration failed:", err);
    process.exit(1);
  });
}
