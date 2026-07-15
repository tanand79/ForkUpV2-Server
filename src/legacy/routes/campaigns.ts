import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import type {
  CampaignDetail,
  CampaignListItem,
  CampaignMethod,
  CampaignStatus,
  MethodType,
  ParticipatingLocation,
  ParticipationCta,
} from "../types/campaign";

export const campaignsRouter = Router();

type CampaignRow = QueryResultRow & {
  id: number;
  slug: string;
  campaign_name: string;
  campaign_story: string;
  campaign_goal: number;
  campaign_start_date: string | Date | null;
  campaign_end_date: string | Date | null;
  campaign_status: CampaignStatus;
  cover_image_url: string;
  raised: number;
  supporters_going: number;
  expected_guests: number;
  verified_visits: number;
  top_event: boolean;
  organization_name: string;
  verification_status: string;
};

type MethodRow = QueryResultRow & {
  id: number;
  method_type: MethodType;
  method_name: string;
  method_status: string;
  requires_business_acceptance: boolean;
};

type LocationRow = QueryResultRow & {
  business_id: number;
  location_id: number;
  method_id: number;
  business_name: string;
  business_type: string;
  location_name: string;
  city: string;
  state: string;
  giveback_percentage: number;
  participation_hours: string | null;
  reservation_url: string | null;
  acceptance_status: string;
  method_type: MethodType;
};

function toDateInput(value: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateRange(start: string | Date | null, end: string | Date | null): string {
  const startDate = toDateInput(start);
  const endDate = toDateInput(end);
  if (!startDate || !endDate) return "Dates TBD";
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

function ctaForMethod(methodType: MethodType, reservationUrl: string | null): ParticipationCta {
  if (methodType === "shop_and_donate") return "shop";
  if (methodType === "service_giveback") return "book";
  if (methodType === "guest_bartending_event") return "attend";
  if (reservationUrl) return "reserve";
  return "visit";
}

function participationMethodLabel(methodType: MethodType): string {
  const labels: Record<MethodType, string> = {
    dine_and_donate: "Dine & Donate",
    shop_and_donate: "Shop & Donate",
    service_giveback: "Service Giveback",
    virtual_donations: "Virtual Donations",
    ambassador_fundraising: "Ambassador Fundraising",
    guest_bartending_event: "Guest Bartender",
  };
  return labels[methodType];
}

function mapLocation(row: LocationRow): ParticipatingLocation {
  return {
    businessId: row.business_id,
    locationId: row.location_id,
    methodId: row.method_id,
    businessName: row.business_name,
    businessType: row.business_type ?? "Business",
    locationName: row.location_name,
    city: row.city ?? "",
    state: row.state ?? "",
    givebackPercentage: Number(row.giveback_percentage),
    participationHours: row.participation_hours,
    participationMethod: participationMethodLabel(row.method_type),
    cta: ctaForMethod(row.method_type, row.reservation_url),
    reservationUrl: row.reservation_url,
    acceptanceStatus: row.acceptance_status,
  };
}

function mapListItem(row: CampaignRow, locationCount: number): CampaignListItem {
  return {
    slug: row.slug,
    name: row.campaign_name,
    nonprofit: row.organization_name,
    nonprofitVerified: row.verification_status === "verified",
    image: row.cover_image_url,
    dateRange: formatDateRange(row.campaign_start_date, row.campaign_end_date),
    raised: Number(row.raised),
    goal: Number(row.campaign_goal),
    supportersGoing: Number(row.supporters_going),
    expectedGuests: Number(row.expected_guests),
    verifiedVisits: Number(row.verified_visits),
    topEvent: Boolean(row.top_event),
    campaignStatus: row.campaign_status,
    participatingLocationCount: locationCount,
  };
}

async function fetchMethods(campaignId: number): Promise<CampaignMethod[]> {
  const { rows: rows } = await pool.query<MethodRow>(
    `SELECT id, method_type, method_name, method_status, requires_business_acceptance
     FROM campaign_methods WHERE campaign_id = $1 ORDER BY id`,
    [campaignId],
  );
  return rows.map((row) => ({
    id: row.id,
    methodType: row.method_type,
    methodName: row.method_name,
    methodStatus: row.method_status,
    requiresBusinessAcceptance: Boolean(row.requires_business_acceptance),
  }));
}

async function fetchAcceptedLocations(campaignId: number): Promise<ParticipatingLocation[]> {
  const { rows: rows } = await pool.query<LocationRow>(
    `SELECT
       b.id AS business_id,
       bl.id AS location_id,
       cm.id AS method_id,
       b.business_name,
       b.business_type,
       bl.location_name,
       bl.city,
       bl.state,
       cbl.giveback_percentage,
       cbl.participation_hours,
       bl.reservation_url,
       cbl.acceptance_status,
       cm.method_type
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN business_locations bl ON bl.id = cbl.location_id
     JOIN campaign_methods cm ON cm.id = cbl.method_id
     WHERE cbl.campaign_id = $1
       AND cbl.acceptance_status IN ('accepted', 'live', 'completed')
     ORDER BY b.business_name, bl.location_name`,
    [campaignId],
  );
  return rows.map(mapLocation);
}

async function fetchLocationCount(campaignId: number): Promise<number> {
  const { rows: rows } = await pool.query<QueryResultRow>(
    `SELECT COUNT(*) AS count FROM campaign_business_locations
     WHERE campaign_id = $1 AND acceptance_status IN ('accepted', 'live', 'completed')`,
    [campaignId],
  );
  return Number(rows[0].count);
}

async function fetchCampaignBySlug(slug: string, options?: { publicOnly?: boolean }): Promise<CampaignDetail | null> {
  const { rows: campaigns } = await pool.query<CampaignRow>(
    `SELECT c.*, n.organization_name, n.verification_status
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.slug = $1`,
    [slug],
  );
  if (campaigns.length === 0) return null;

  const campaign = campaigns[0];
  if (options?.publicOnly) {
    const status = String(campaign.campaign_status);
    if (status !== "live" && status !== "closed") return null;
  }
  const [methods, locations] = await Promise.all([
    fetchMethods(campaign.id),
    fetchAcceptedLocations(campaign.id),
  ]);

  return {
    ...mapListItem(campaign, locations.length),
    description: campaign.campaign_story,
    methods,
    participatingLocations: locations,
  };
}

campaignsRouter.get("/", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;

    // Promote campaigns whose start date has arrived before listing public campaigns.
    await pool.query(
      `UPDATE campaigns SET campaign_status = 'live', updated_at = NOW()
       WHERE campaign_status = 'ready_to_launch'
         AND campaign_start_date IS NOT NULL
         AND campaign_start_date <= CURRENT_DATE`,
    );

    const whereClause = status
      ? "WHERE c.campaign_status = $1"
      : "WHERE c.campaign_status = 'live'";
    const params = status ? [status] : [];

    const { rows: campaigns } = await pool.query<CampaignRow>(
      `SELECT c.*, n.organization_name, n.verification_status
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       ${whereClause}
       ORDER BY c.top_event DESC, c.raised DESC`,
      params,
    );

    const results = await Promise.all(
      campaigns.map(async (campaign) => {
        const locationCount = await fetchLocationCount(campaign.id);
        return mapListItem(campaign, locationCount);
      }),
    );

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

campaignsRouter.post("/:slug/donations", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { amount, donorName, email, anonymous, attributionCode } = req.body as Record<
      string,
      unknown
    >;

    const donationAmount = Number(amount);
    if (!Number.isFinite(donationAmount) || donationAmount < 1) {
      res.status(400).json({ error: "Valid donation amount is required" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      `SELECT id, campaign_status FROM campaigns WHERE slug = $1`,
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const campaign = campaigns[0];
    const status = String(campaign.campaign_status);
    if (status !== "live") {
      res.status(400).json({ error: "This campaign is not accepting donations yet" });
      return;
    }

    const campaignId = Number(campaign.id);
    const normalizedEmail = email.trim().toLowerCase();
    const displayName =
      anonymous || !donorName || typeof donorName !== "string"
        ? "Anonymous"
        : donorName.trim();

    await connection.query("BEGIN");

    const { rows: existingSupporters } = await connection.query<QueryResultRow>(
      "SELECT id FROM supporters WHERE email = $1",
      [normalizedEmail],
    );

    let supporterId: number;
    if (existingSupporters.length > 0) {
      supporterId = Number(existingSupporters[0].id);
    } else {
      const { rows: supporterResult } = await connection.query<{ id: number }>(
        "INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id",
        [displayName, normalizedEmail],
      );
      supporterId = supporterResult[0].id;
    }

    const { rows: methods } = await connection.query<QueryResultRow>(
      `SELECT id FROM campaign_methods
       WHERE campaign_id = $1 AND method_type = 'virtual_donations' LIMIT 1`,
      [campaignId],
    );
    const methodId = methods.length > 0 ? Number(methods[0].id) : null;

    await connection.query(
      `INSERT INTO donations (
        campaign_id, method_id, supporter_id, amount, donation_type,
        payment_status, attribution_code, notes
      ) VALUES ($1, $2, $3, $4, 'virtual', 'completed', $5, $6)`,
      [
        campaignId,
        methodId,
        supporterId,
        donationAmount,
        typeof attributionCode === "string" ? attributionCode : null,
        anonymous ? "anonymous" : null,
      ],
    );

    await connection.query(
      `UPDATE campaigns SET raised = raised + $1, updated_at = NOW() WHERE id = $2`,
      [Math.round(donationAmount), campaignId],
    );

    const { rows: updated } = await connection.query<QueryResultRow>(
      "SELECT raised FROM campaigns WHERE id = $1",
      [campaignId],
    );

    await connection.query("COMMIT");

    res.status(201).json({
      success: true,
      amount: donationAmount,
      raised: Number(updated[0].raised),
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to record donation" });
  } finally {
    connection.release();
  }
});

campaignsRouter.post("/:slug/participate", async (req, res) => {
  const connection = await pool.connect();
  try {
    const { firstName, email, partySize, isFirstVisit, businessId, locationId, methodId } =
      req.body as Record<string, unknown>;

    if (!firstName || typeof firstName !== "string" || !firstName.trim()) {
      res.status(400).json({ error: "First name is required" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }
    const guests = Number(partySize);
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
      res.status(400).json({ error: "Party size must be between 1 and 50" });
      return;
    }

    const bizId = Number(businessId);
    const locId = Number(locationId);
    const methId = Number(methodId);
    if (!bizId || !locId || !methId) {
      res.status(400).json({ error: "Business, location, and method are required" });
      return;
    }

    const { rows: campaigns } = await connection.query<QueryResultRow>(
      "SELECT id FROM campaigns WHERE slug = $1 AND campaign_status = 'live'",
      [req.params.slug],
    );
    if (campaigns.length === 0) {
      res.status(404).json({ error: "Campaign not found or not live" });
      return;
    }
    const campaignId = Number(campaigns[0].id);

    const { rows: locations } = await connection.query<LocationRow>(
      `SELECT
         b.id AS business_id,
         bl.id AS location_id,
         cm.id AS method_id,
         b.business_name,
         b.business_type,
         bl.location_name,
         bl.city,
         bl.state,
         cbl.giveback_percentage,
         cbl.participation_hours,
         bl.reservation_url,
         cbl.acceptance_status,
         cm.method_type
       FROM campaign_business_locations cbl
       JOIN businesses b ON b.id = cbl.business_id
       JOIN business_locations bl ON bl.id = cbl.location_id
       JOIN campaign_methods cm ON cm.id = cbl.method_id
       WHERE cbl.campaign_id = $1
         AND cbl.business_id = $2
         AND cbl.location_id = $3
         AND cbl.method_id = $4
         AND cbl.acceptance_status IN ('accepted', 'live', 'completed')`,
      [campaignId, bizId, locId, methId],
    );
    if (locations.length === 0) {
      res.status(400).json({ error: "Selected location is not part of this campaign" });
      return;
    }

    const location = locations[0];
    const participationPath = location.reservation_url ? "reservation" : "walk_in";
    const normalizedEmail = email.trim().toLowerCase();

    await connection.query("BEGIN");

    const { rows: existingSupporters } = await connection.query<QueryResultRow>(
      "SELECT id FROM supporters WHERE email = $1",
      [normalizedEmail],
    );

    let supporterId: number;
    if (existingSupporters.length > 0) {
      supporterId = Number(existingSupporters[0].id);
    } else {
      const { rows: supporterResult } = await connection.query<{ id: number }>(
        "INSERT INTO supporters (first_name, email) VALUES ($1, $2) RETURNING id",
        [firstName.trim(), normalizedEmail],
      );
      supporterId = supporterResult[0].id;
    }

    await connection.query(
      `INSERT INTO participation_intents (
        campaign_id, method_id, business_id, location_id, supporter_id,
        party_size, is_first_visit, participation_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        campaignId,
        methId,
        bizId,
        locId,
        supporterId,
        guests,
        Boolean(isFirstVisit),
        participationPath,
      ],
    );

    await connection.query(
      `UPDATE campaigns
       SET supporters_going = supporters_going + 1,
           expected_guests = expected_guests + $1
       WHERE id = $2`,
      [guests, campaignId],
    );

    const { rows: updated } = await connection.query<QueryResultRow>(
      "SELECT supporters_going, expected_guests FROM campaigns WHERE id = $1",
      [campaignId],
    );

    await connection.query("COMMIT");

    res.status(201).json({
      success: true,
      participationPath,
      reservationUrl: location.reservation_url,
      businessName: location.business_name,
      locationName: location.location_name,
      supportersGoing: Number(updated[0].supporters_going),
      expectedGuests: Number(updated[0].expected_guests),
    });
  } catch (err) {
    await connection.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to record participation" });
  } finally {
    connection.release();
  }
});

campaignsRouter.get("/:slug", async (req, res) => {
  try {
    const campaign = await fetchCampaignBySlug(req.params.slug, { publicOnly: true });
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    res.json(campaign);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});
