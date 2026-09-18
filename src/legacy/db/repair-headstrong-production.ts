/**
 * One-shot production repair: release orphaned Headstrong claim.
 * Run on a host that can reach RDS (e.g. EC2), same as inspect-production-schema:
 *   cd Forkup-Server
 *   npx tsx src/legacy/db/repair-headstrong-production.ts
 *
 * Updates only id=Headstrong-by-name when claim is orphaned (no claimant, no members).
 */
process.env.NODE_ENV = "production";
process.env.DATABASE_TARGET = "production";

async function main() {
  const { config } = await import("../config");
  const { pool } = await import("./pool");
  console.log("TARGET", config.databaseTarget);
  console.log("URL", config.databaseUrl.replace(/:([^:@/]+)@/, ":****@"));

  const before = await pool.query(
    `SELECT id, organization_name, claim_status, profile_status, claimed_by_user_id, contact_email,
            (SELECT COUNT(*)::int FROM organization_users ou
              WHERE ou.organization_type = 'nonprofit' AND ou.organization_id = n.id) AS member_count
     FROM nonprofits n
     WHERE n.organization_name ILIKE 'Headstrong'
     ORDER BY n.id`,
  );
  console.log("BEFORE", JSON.stringify(before.rows, null, 2));

  const result = await pool.query(
    `UPDATE nonprofits
     SET claim_status = 'unclaimed',
         profile_status = 'preloaded',
         updated_at = CURRENT_TIMESTAMP
     WHERE organization_name ILIKE 'Headstrong'
       AND claim_status = 'claimed'
       AND claimed_by_user_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM organization_users ou
         WHERE ou.organization_type = 'nonprofit'
           AND ou.organization_id = nonprofits.id
       )
     RETURNING id, organization_name, claim_status, profile_status, claimed_by_user_id`,
  );
  console.log("UPDATED", JSON.stringify(result.rows, null, 2));
  console.log("rowCount", result.rowCount);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
