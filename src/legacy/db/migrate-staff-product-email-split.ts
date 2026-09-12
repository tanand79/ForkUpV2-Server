/**
 * Pass 1 — staff vs product accounts may share the same email.
 *
 * Purpose: Allow one platform-admin (staff) row and one product row per email
 * so staff login stays separate while NPO/business/fundraiser can sign up with
 * the same address.
 *
 * Inputs: none. Outputs:
 * - Drop global UNIQUE(users.email)
 * - Partial unique indexes: one staff email, one product email (case-insensitive)
 *
 * Existing rows unchanged. Safe to re-run (IF EXISTS / IF NOT EXISTS).
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const DDL = `
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_product_email_lower
  ON users (LOWER(email))
  WHERE COALESCE(is_platform_admin, FALSE) = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_staff_email_lower
  ON users (LOWER(email))
  WHERE COALESCE(is_platform_admin, FALSE) = TRUE;
`;

/**
 * Apply staff/product email split indexes.
 */
export async function migrateStaffProductEmailSplit(
  options: DbTaskOptions = {},
) {
  await pool.query(DDL);
  console.log(
    "ForkUp staff/product email split applied (partial unique LOWER(email) by is_platform_admin).",
  );
  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  migrateStaffProductEmailSplit().catch((err) => {
    console.error("staff/product email split migration failed:", err);
    process.exit(1);
  });
}
