import type { PoolClient, QueryResultRow } from "pg";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

/**
 * Demo seed data removed — production and local discovery should only show
 * real campaigns created through the app.
 *
 * `npm run db:seed` is now a no-op unless arrays below are intentionally
 * re-populated for a controlled QA fixture.
 */

type NonprofitSeed = {
  organization_name: string;
  slug: string;
  mission: string;
  cause_category: string;
  verification_status: "verified" | "claimed" | "unclaimed";
};

type BusinessSeed = {
  business_name: string;
  slug: string;
  business_type: string;
  contact_email: string;
  default_giveback_percentage: number;
  supports_dine_and_donate: boolean;
  supports_shop_and_donate: boolean;
  supports_service_giveback: boolean;
  supports_guest_bartending: boolean;
  locations: {
    location_name: string;
    city: string;
    state: string;
    reservation_url?: string;
  }[];
};

type CampaignSeed = {
  slug: string;
  campaign_name: string;
  nonprofit_slug: string;
  campaign_story: string;
  campaign_goal: number;
  campaign_start_date: string;
  campaign_end_date: string;
  campaign_status: "live" | "invitation_phase" | "ready_to_launch" | "draft";
  cover_image_url: string;
  raised: number;
  supporters_going: number;
  expected_guests: number;
  verified_visits: number;
  top_event: boolean;
  methods: {
    method_type: "dine_and_donate" | "shop_and_donate" | "virtual_donations" | "guest_bartending_event";
    method_name: string;
    method_status: "live" | "accepted" | "draft";
    requires_business_acceptance: boolean;
  }[];
  participants: {
    business_slug: string;
    location_name: string;
    giveback_percentage: number;
    participation_hours?: string;
    acceptance_status: "accepted" | "invited" | "pending";
  }[];
};

/** Former demo orgs — kept empty so seed does not recreate sample data. */
const nonprofits: NonprofitSeed[] = [];

/** Former demo businesses — kept empty. */
const businesses: BusinessSeed[] = [];

/** Former demo live campaigns — kept empty. */
const campaigns: CampaignSeed[] = [];

/** Known historical demo campaign slugs (for one-time cleanup). */
export const DEMO_CAMPAIGN_SLUGS = [
  "sovana-dine-and-donate-spring",
  "bayside-animal-rescue",
  "riverdale-youth-arts",
  "greenleaf-food-bank",
] as const;

const SEED_TABLES = [
  "success_engine_actions",
  "settlements",
  "receipts",
  "participation_intents",
  "campaign_participants",
  "business_acceptances",
  "invitation_tokens",
  "campaign_business_locations",
  "campaign_methods",
  "campaigns",
  "supporters",
  "business_locations",
  "businesses",
  "nonprofits",
];

async function resetPartialSeed(connection: PoolClient) {
  for (const table of SEED_TABLES) {
    await connection.query(`DELETE FROM ${table}`);
  }
}

/**
 * Remove only the known demo live campaigns (and cascade children via FKs).
 * Does not wipe real organizer-created campaigns.
 */
export async function clearDemoCampaigns(options: DbTaskOptions = {}) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const { rowCount } = await connection.query(
      `DELETE FROM campaigns WHERE slug = ANY($1::text[])`,
      [DEMO_CAMPAIGN_SLUGS],
    );
    await connection.query("COMMIT");
    console.log(`Removed ${rowCount ?? 0} demo campaign(s).`);
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
    if (options.closePool !== false) {
      await pool.end();
    }
  }
}

export async function seed(options: DbTaskOptions & { force?: boolean } = {}) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    // Always strip known demo live campaigns so the public directory stays clean.
    const cleared = await connection.query(`DELETE FROM campaigns WHERE slug = ANY($1::text[])`, [
      DEMO_CAMPAIGN_SLUGS,
    ]);

    if (nonprofits.length === 0 && businesses.length === 0 && campaigns.length === 0) {
      await connection.query("COMMIT");
      console.log(
        `Cleared ${cleared.rowCount ?? 0} demo campaign(s). Seed arrays empty — no sample data inserted.`,
      );
      return;
    }

    const { rows: existing } = await connection.query<QueryResultRow>(
      "SELECT COUNT(*) AS count FROM campaigns",
    );
    if (!options.force && Number(existing[0].count) > 0) {
      console.log("Campaigns already present, skipping fixture insert.");
      await connection.query("COMMIT");
      return;
    }

    if (options.force || Number(existing[0].count) > 0) {
      console.log("Resetting demo tables before seed…");
      await resetPartialSeed(connection);
      await connection.query("DELETE FROM auth_sessions");
      await connection.query("DELETE FROM organization_users");
      await connection.query("DELETE FROM users");
    } else {
      const { rows: nonprofitRows } = await connection.query<QueryResultRow>(
        "SELECT COUNT(*) AS count FROM nonprofits",
      );
      if (Number(nonprofitRows[0].count) > 0) {
        console.log("Partial seed detected; resetting demo tables.");
        await resetPartialSeed(connection);
      }
    }

    const nonprofitIds = new Map<string, number>();
    for (const np of nonprofits) {
      const { rows: result } = await connection.query<{ id: number }>(
        `INSERT INTO nonprofits (organization_name, slug, mission, cause_category, verification_status, claim_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [np.organization_name, np.slug, np.mission, np.cause_category, np.verification_status, "claimed"],
      );
      nonprofitIds.set(np.slug, result[0].id);
    }

    const businessIds = new Map<string, number>();
    const locationIds = new Map<string, number>();

    for (const biz of businesses) {
      const { rows: result } = await connection.query<{ id: number }>(
        `INSERT INTO businesses (
          business_name, slug, business_type, contact_email, default_giveback_percentage,
          supports_dine_and_donate, supports_shop_and_donate, supports_service_giveback,
          supports_guest_bartending, business_status, claim_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 'claimed') RETURNING id`,
        [
          biz.business_name,
          biz.slug,
          biz.business_type,
          biz.contact_email,
          biz.default_giveback_percentage,
          biz.supports_dine_and_donate,
          biz.supports_shop_and_donate,
          biz.supports_service_giveback,
          biz.supports_guest_bartending,
        ],
      );
      businessIds.set(biz.slug, result[0].id);

      for (const loc of biz.locations) {
        const { rows: locResult } = await connection.query<{ id: number }>(
          `INSERT INTO business_locations (business_id, location_name, city, state, reservation_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [result[0].id, loc.location_name, loc.city, loc.state, loc.reservation_url ?? null],
        );
        locationIds.set(`${biz.slug}:${loc.location_name}`, locResult[0].id);
      }
    }

    for (const campaign of campaigns) {
      const nonprofitId = nonprofitIds.get(campaign.nonprofit_slug);
      if (!nonprofitId) continue;

      const { rows: campResult } = await connection.query<{ id: number }>(
        `INSERT INTO campaigns (
          slug, nonprofit_id, campaign_name, campaign_story, campaign_goal,
          campaign_start_date, campaign_end_date, campaign_status, cover_image_url,
          raised, supporters_going, expected_guests, verified_visits, top_event, terms_accepted
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE) RETURNING id`,
        [
          campaign.slug,
          nonprofitId,
          campaign.campaign_name,
          campaign.campaign_story,
          campaign.campaign_goal,
          campaign.campaign_start_date,
          campaign.campaign_end_date,
          campaign.campaign_status,
          campaign.cover_image_url,
          campaign.raised,
          campaign.supporters_going,
          campaign.expected_guests,
          campaign.verified_visits,
          campaign.top_event,
        ],
      );
      const campaignId = campResult[0].id;

      const methodIds: number[] = [];
      for (const method of campaign.methods) {
        const { rows: methodResult } = await connection.query<{ id: number }>(
          `INSERT INTO campaign_methods (
            campaign_id, method_type, method_name, method_status, requires_business_acceptance
          ) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            campaignId,
            method.method_type,
            method.method_name,
            method.method_status,
            method.requires_business_acceptance,
          ],
        );
        methodIds.push(methodResult[0].id);
      }

      const primaryMethodId = methodIds[0];
      for (const participant of campaign.participants) {
        const businessId = businessIds.get(participant.business_slug);
        const locationId = locationIds.get(
          `${participant.business_slug}:${participant.location_name}`,
        );
        if (!businessId || !locationId) continue;

        await connection.query(
          `INSERT INTO campaign_business_locations (
            campaign_id, method_id, business_id, location_id,
            invite_status, acceptance_status, giveback_percentage,
            participation_hours, terms_confirmed, ach_authorized
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, TRUE)`,
          [
            campaignId,
            primaryMethodId,
            businessId,
            locationId,
            participant.acceptance_status,
            participant.acceptance_status,
            participant.giveback_percentage,
            participant.participation_hours ?? null,
          ],
        );
      }

      const successActions = [
        {
          action_type: "launch_email",
          title: "Campaign Launch Email",
          content: `We're live! Share ${campaign.campaign_name} with your community and encourage supporters to dine, shop, and participate.`,
        },
        {
          action_type: "one_week_reminder",
          title: "One Week Reminder",
          content: "One week left — remind supporters to visit participating businesses and upload receipts.",
        },
        {
          action_type: "final_push_reminder",
          title: "Final Push Reminder",
          content: "Final days of the campaign — share progress and encourage last-minute participation.",
        },
      ];

      for (const action of successActions) {
        await connection.query(
          `INSERT INTO success_engine_actions (campaign_id, action_type, channel, title, content, status)
           VALUES ($1, $2, 'email', $3, $4, 'ready')`,
          [campaignId, action.action_type, action.title, action.content],
        );
      }
    }

    await connection.query("COMMIT");
    console.log(
      `Seeded ${nonprofits.length} nonprofits, ${businesses.length} businesses, ${campaigns.length} campaigns.`,
    );
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
    if (options.closePool !== false) {
      await pool.end();
    }
  }
}

if (isDirectRun(import.meta.url)) {
  seed().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
