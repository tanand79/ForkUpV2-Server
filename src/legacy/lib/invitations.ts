import { randomBytes } from "crypto";
import type { PoolClient, QueryResultRow } from "pg";

export function generateInvitationToken(): string {
  return randomBytes(32).toString("hex");
}

export async function ensureInvitationToken(
  connection: PoolClient,
  campaignBusinessLocationId: number,
): Promise<string> {
  const { rows: existing } = await connection.query<QueryResultRow>(
    "SELECT token FROM invitation_tokens WHERE campaign_business_location_id = $1",
    [campaignBusinessLocationId],
  );
  if (existing.length > 0) {
    return String(existing[0].token);
  }

  const token = generateInvitationToken();
  await connection.query<{ id: number }>(
    "INSERT INTO invitation_tokens (campaign_business_location_id, token) VALUES ($1, $2) RETURNING id",
    [campaignBusinessLocationId, token],
  );
  return token;
}

export async function evaluateCampaignInvitationPhase(
  connection: PoolClient,
  campaignId: number,
): Promise<void> {
  const { rows: rows } = await connection.query<QueryResultRow>(
    `SELECT acceptance_status FROM campaign_business_locations WHERE campaign_id = $1`,
    [campaignId],
  );
  if (rows.length === 0) return;

  const statuses = rows.map((r) => String(r.acceptance_status));
  const hasAccepted = statuses.includes("accepted");
  const allResolved = statuses.every((s) =>
    ["accepted", "declined", "changes_requested"].includes(s),
  );

  if (hasAccepted && allResolved) {
    await connection.query(
      `UPDATE campaigns SET campaign_status = 'ready_to_launch', updated_at = NOW()
       WHERE id = $1 AND campaign_status = 'invitation_phase'`,
      [campaignId],
    );
  }

  await maybePromoteCampaignToLive(connection, campaignId);
}

/** Public directory only lists `live` campaigns — promote when the start date arrives. */
export async function maybePromoteCampaignToLive(
  connection: PoolClient,
  campaignId: number,
): Promise<void> {
  const { rows: rows } = await connection.query<QueryResultRow>(
    `SELECT campaign_status, campaign_start_date FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (rows.length === 0) return;

  const status = String(rows[0].campaign_status);
  if (status !== "ready_to_launch") return;

  const startRaw = rows[0].campaign_start_date;
  if (!startRaw) return;

  const start =
    startRaw instanceof Date
      ? new Date(startRaw.getFullYear(), startRaw.getMonth(), startRaw.getDate())
      : new Date(`${String(startRaw).slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (start.getTime() <= today.getTime()) {
    await connection.query(
      `UPDATE campaigns SET campaign_status = 'live', updated_at = NOW()
       WHERE id = $1 AND campaign_status = 'ready_to_launch'`,
      [campaignId],
    );
  }
}
