/**
 * Additive migration: allow campaign_status value `in_review`.
 *
 * Purpose: Support Launch → ForkUp review → superadmin approve → live flow.
 * Extends the existing campaigns.campaign_status CHECK only — no column drops
 * or type changes. Existing rows keep their current status.
 *
 * Inputs: none (uses pool / DATABASE_TARGET).
 * Outputs: CHECK constraint includes `in_review`; console summary.
 *
 * Run: npx tsx src/legacy/db/migrate-campaign-in-review.ts
 *   or: npm run db:campaign-in-review
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const CONSTRAINT = "campaigns_campaign_status_check";
const STATUS_VALUES = [
  "draft",
  "in_review",
  "invitation_phase",
  "ready_to_launch",
  "live",
  "closed",
  "settlement",
];

/**
 * Returns true when the named CHECK already allows `in_review`.
 */
async function constraintAllowsInReview(constraintName: string): Promise<boolean> {
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
  return /'in_review'/i.test(def);
}

/**
 * Expands campaigns.campaign_status CHECK to include `in_review`.
 * Idempotent: no-ops if already allowed.
 */
export async function migrateCampaignInReview(options: DbTaskOptions = {}) {
  await pool.query(`SET lock_timeout = '15s'`);

  const already = await constraintAllowsInReview(CONSTRAINT);
  if (already) {
    console.log(`OK (already): ${CONSTRAINT} allows in_review`);
  } else {
    const list = STATUS_VALUES.map((v) => `'${v}'`).join(", ");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await client.query(
        `ALTER TABLE campaigns
         ADD CONSTRAINT ${CONSTRAINT}
         CHECK (campaign_status::text = ANY (ARRAY[${list}]::text[]))`,
      );
      await client.query("COMMIT");
      console.log(`Updated ${CONSTRAINT} to allow in_review`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("Campaign in_review status migration complete.");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateCampaignInReview().catch((err) => {
    console.error("Campaign in_review migration failed:", err);
    process.exit(1);
  });
}
