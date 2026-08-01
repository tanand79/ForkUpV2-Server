/**
 * Additive migration: allow forkup_review_status value `changes_requested`.
 *
 * Purpose: Superadmin ForkUp review can request changes (not only approve/deny).
 * Extends campaigns.forkup_review_status CHECK only — no column drops/type changes.
 *
 * Inputs: none (uses pool / DATABASE_TARGET).
 * Outputs: CHECK includes `changes_requested`; console summary.
 *
 * Run: npx tsx src/legacy/db/migrate-forkup-review-changes-requested.ts
 *   or: npm run db:forkup-review-changes-requested
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const CONSTRAINT = "campaigns_forkup_review_status_check";
const STATUS_VALUES = [
  "none",
  "pending",
  "approved",
  "denied",
  "changes_requested",
];

/**
 * Returns true when the named CHECK already allows `changes_requested`.
 */
async function constraintAllowsChangesRequested(
  constraintName: string,
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
  return /'changes_requested'/i.test(def);
}

/**
 * Expands campaigns.forkup_review_status CHECK to include `changes_requested`.
 * Idempotent: no-ops if already allowed.
 */
export async function migrateForkupReviewChangesRequested(
  options: DbTaskOptions = {},
) {
  await pool.query(`SET lock_timeout = '15s'`);

  const already = await constraintAllowsChangesRequested(CONSTRAINT);
  if (already) {
    console.log(`OK (already): ${CONSTRAINT} allows changes_requested`);
  } else {
    const list = STATUS_VALUES.map((v) => `'${v}'`).join(", ");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await client.query(
        `ALTER TABLE campaigns
         ADD CONSTRAINT ${CONSTRAINT}
         CHECK (forkup_review_status::text = ANY (ARRAY[${list}]::text[]))`,
      );
      await client.query("COMMIT");
      console.log(`Updated ${CONSTRAINT} to allow changes_requested`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("ForkUp review changes_requested migration complete.");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateForkupReviewChangesRequested().catch((err) => {
    console.error("ForkUp review changes_requested migration failed:", err);
    process.exit(1);
  });
}
