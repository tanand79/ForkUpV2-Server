import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import crypto from "crypto";
import { pool } from "../db/pool";

export const participantsRouter = Router({ mergeParams: true });

type ParticipantParams = { slug: string; participantId?: string };

function trackingCode(): string {
  return crypto.randomBytes(4).toString("hex");
}

function mapParticipant(row: QueryResultRow, campaignSlug: string) {
  const code = row.tracking_code as string;
  return {
    id: row.id,
    participantType: row.participant_type,
    name: row.name,
    email: row.email,
    roleLabel: row.role_label,
    status: row.status,
    personalShareLink: row.personal_share_link,
    trackingCode: code,
    shareUrl: code ? `/campaign/${campaignSlug}?ref=${code}` : null,
    leaderboardEnabled: Boolean(row.leaderboard_enabled),
    businessId: row.business_id,
    locationId: row.location_id,
    eventDate: row.event_date,
    eventStartTime: row.event_start_time,
    eventEndTime: row.event_end_time,
    attributedDonationTotal: Number(row.attributed_donation_total ?? 0),
  };
}

async function campaignIdFromSlug(slug: string): Promise<number | null> {
  const { rows: rows } = await pool.query<QueryResultRow>(
    "SELECT id FROM campaigns WHERE slug = $1",
    [slug],
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

async function methodIdForType(
  campaignId: number,
  methodType: "ambassador_fundraising" | "guest_bartending_event",
): Promise<number | null> {
  const { rows: rows } = await pool.query<QueryResultRow>(
    `SELECT id FROM campaign_methods WHERE campaign_id = $1 AND method_type = $2 LIMIT 1`,
    [campaignId, methodType],
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

participantsRouter.get("/", async (req, res) => {
  try {
    const { slug } = req.params as ParticipantParams;
    const campaignId = await campaignIdFromSlug(slug);
    if (!campaignId) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const { rows: rows } = await pool.query<QueryResultRow>(
      `SELECT * FROM campaign_participants WHERE campaign_id = $1 ORDER BY created_at DESC`,
      [campaignId],
    );

    res.json(rows.map((r) => mapParticipant(r, slug)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
});

participantsRouter.post("/", async (req, res) => {
  try {
    const { slug } = req.params as ParticipantParams;
    const body = req.body as {
      participantType?: "ambassador" | "guest_bartender";
      name?: string;
      email?: string;
      roleLabel?: string;
      businessId?: number;
      locationId?: number;
      eventDate?: string;
      eventStartTime?: string;
      eventEndTime?: string;
    };

    if (!body.name?.trim()) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    if (!body.participantType || !["ambassador", "guest_bartender"].includes(body.participantType)) {
      res.status(400).json({ error: "participantType must be ambassador or guest_bartender" });
      return;
    }

    const campaignId = await campaignIdFromSlug(slug);
    if (!campaignId) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const methodType =
      body.participantType === "ambassador" ? "ambassador_fundraising" : "guest_bartending_event";
    const methodId = await methodIdForType(campaignId, methodType);

    const code = trackingCode();
    const sharePath = `/campaign/${slug}?ref=${code}`;

    const { rows: result } = await pool.query<{ id: number }>(
      `INSERT INTO campaign_participants (
        campaign_id, method_id, participant_type, name, email, role_label,
        status, personal_share_link, tracking_code, leaderboard_enabled,
        business_id, location_id, event_date, event_start_time, event_end_time
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, TRUE, $9, $10, $11, $12, $13) RETURNING id`,
      [
        campaignId,
        methodId,
        body.participantType,
        body.name.trim(),
        body.email?.trim() ?? null,
        body.roleLabel?.trim() ?? null,
        sharePath,
        code,
        body.businessId ?? null,
        body.locationId ?? null,
        body.eventDate ?? null,
        body.eventStartTime ?? null,
        body.eventEndTime ?? null,
      ],
    );

    const { rows: created } = await pool.query<QueryResultRow>(
      "SELECT * FROM campaign_participants WHERE id = $1",
      [result[0].id],
    );

    res.status(201).json(mapParticipant(created[0], slug));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add participant" });
  }
});

participantsRouter.delete("/:participantId", async (req, res) => {
  try {
    const { slug } = req.params as ParticipantParams;
    const campaignId = await campaignIdFromSlug(slug);
    if (!campaignId) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    await pool.query(
      "DELETE FROM campaign_participants WHERE id = $1 AND campaign_id = $2",
      [req.params.participantId, campaignId],
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove participant" });
  }
});
