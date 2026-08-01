/**
 * Additive migration: allow verification/claim status value `denied`.
 *
 * Extends existing CHECK constraints so admins can mark claim verification
 * as denied and the requester UI can show that status.
 *
 * Safe to re-run (no-ops if `denied` already allowed).
 * Each constraint is altered in its own short transaction to avoid long locks.
 *
 * Inputs: none (uses pool / DATABASE_TARGET).
 * Outputs: updated CHECK constraints on nonprofits + businesses; console summary.
 *
 * Run: npx tsx src/legacy/db/migrate-verification-denied.ts
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const TARGETS: { table: string; column: string; constraint: string; values: string[] }[] = [
  {
    table: "nonprofits",
    column: "verification_status",
    constraint: "nonprofits_verification_status_check",
    values: ["unclaimed", "claimed", "verified", "needs_review", "archived", "denied"],
  },
  {
    table: "nonprofits",
    column: "claim_status",
    constraint: "nonprofits_claim_status_check",
    values: ["unclaimed", "claimed", "verified", "needs_review", "archived", "denied"],
  },
  {
    table: "businesses",
    column: "claim_status",
    constraint: "businesses_claim_status_check",
    values: ["unclaimed", "claimed", "verified", "needs_review", "archived", "denied"],
  },
];

async function constraintAllowsDenied(constraintName: string): Promise<boolean> {
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
  return /'denied'/i.test(def);
}

export async function migrateVerificationDenied(options: DbTaskOptions = {}) {
  await pool.query(`SET lock_timeout = '15s'`);

  for (const t of TARGETS) {
    const already = await constraintAllowsDenied(t.constraint);
    if (already) {
      console.log(`OK (already): ${t.constraint} allows denied`);
      continue;
    }

    const list = t.values.map((v) => `'${v}'`).join(", ");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ${t.table} DROP CONSTRAINT IF EXISTS ${t.constraint}`);
      await client.query(
        `ALTER TABLE ${t.table}
         ADD CONSTRAINT ${t.constraint}
         CHECK (${t.column}::text = ANY (ARRAY[${list}]::text[]))`,
      );
      await client.query("COMMIT");
      console.log(`Updated ${t.constraint} to allow denied`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("Verification denied status migration complete.");
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateVerificationDenied().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
