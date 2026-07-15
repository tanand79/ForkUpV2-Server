import type { PoolClient, QueryResultRow } from "pg";
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

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

const nonprofits: NonprofitSeed[] = [
  {
    organization_name: "West Chester Education Foundation",
    slug: "west-chester-education-foundation",
    mission: "Supporting teachers and students across West Chester Area School District.",
    cause_category: "Education",
    verification_status: "verified",
  },
  {
    organization_name: "Bayside Animal Rescue",
    slug: "bayside-animal-rescue",
    mission: "Medical care, shelter, and adoption services for rescued animals.",
    cause_category: "Animals",
    verification_status: "verified",
  },
  {
    organization_name: "Riverdale Youth Arts",
    slug: "riverdale-youth-arts",
    mission: "Free art classes and supplies for after-school youth programs.",
    cause_category: "Arts",
    verification_status: "verified",
  },
  {
    organization_name: "GreenLeaf Food Bank",
    slug: "greenleaf-food-bank",
    mission: "Groceries for families facing food insecurity.",
    cause_category: "Hunger Relief",
    verification_status: "verified",
  },
];

const businesses: BusinessSeed[] = [
  {
    business_name: "Sovana Bistro",
    slug: "sovana-bistro",
    business_type: "Restaurant",
    contact_email: "ops@sovanabistro.com",
    default_giveback_percentage: 15,
    supports_dine_and_donate: true,
    supports_shop_and_donate: false,
    supports_service_giveback: false,
    supports_guest_bartending: true,
    locations: [
      { location_name: "Kennett Square", city: "Kennett Square", state: "PA", reservation_url: "https://resy.com" },
    ],
  },
  {
    business_name: "The Pear",
    slug: "the-pear",
    business_type: "Restaurant",
    contact_email: "ops@thepear.com",
    default_giveback_percentage: 15,
    supports_dine_and_donate: true,
    supports_shop_and_donate: false,
    supports_service_giveback: false,
    supports_guest_bartending: true,
    locations: [
      { location_name: "Dilworthtown", city: "West Chester", state: "PA", reservation_url: "https://resy.com" },
    ],
  },
  {
    business_name: "Olive & Oak",
    slug: "olive-and-oak",
    business_type: "Restaurant",
    contact_email: "manager@oliveandoak.com",
    default_giveback_percentage: 10,
    supports_dine_and_donate: true,
    supports_shop_and_donate: false,
    supports_service_giveback: false,
    supports_guest_bartending: false,
    locations: [{ location_name: "Downtown", city: "Bayside", state: "CA" }],
  },
  {
    business_name: "Harbor Coffee",
    slug: "harbor-coffee",
    business_type: "Cafe",
    contact_email: "hello@harborcoffee.com",
    default_giveback_percentage: 10,
    supports_dine_and_donate: true,
    supports_shop_and_donate: false,
    supports_service_giveback: false,
    supports_guest_bartending: false,
    locations: [{ location_name: "Harbor District", city: "Bayside", state: "CA" }],
  },
  {
    business_name: "Farm Table",
    slug: "farm-table",
    business_type: "Restaurant",
    contact_email: "team@farmtable.com",
    default_giveback_percentage: 12,
    supports_dine_and_donate: true,
    supports_shop_and_donate: false,
    supports_service_giveback: false,
    supports_guest_bartending: false,
    locations: [{ location_name: "Pearl District", city: "Portland", state: "OR" }],
  },
  {
    business_name: "Maker Studio",
    slug: "maker-studio",
    business_type: "Retail",
    contact_email: "shop@makerstudio.com",
    default_giveback_percentage: 8,
    supports_dine_and_donate: false,
    supports_shop_and_donate: true,
    supports_service_giveback: false,
    supports_guest_bartending: false,
    locations: [{ location_name: "Main Street", city: "Riverdale", state: "NY" }],
  },
];

const campaigns: CampaignSeed[] = [
  {
    slug: "sovana-dine-and-donate-spring",
    campaign_name: "Dine & Donate for West Chester Schools",
    nonprofit_slug: "west-chester-education-foundation",
    campaign_story:
      "Join Sovana Bistro and The Pear for a community Dine & Donate campaign supporting West Chester Area School District teachers and students. Dine at participating locations and a portion of eligible sales goes directly to the foundation.",
    campaign_goal: 25000,
    campaign_start_date: "2026-05-01",
    campaign_end_date: "2026-05-14",
    campaign_status: "live",
    cover_image_url: "campaign-restaurant.jpg",
    raised: 18760,
    supporters_going: 142,
    expected_guests: 318,
    verified_visits: 89,
    top_event: true,
    methods: [
      {
        method_type: "dine_and_donate",
        method_name: "Dine & Donate",
        method_status: "live",
        requires_business_acceptance: true,
      },
    ],
    participants: [
      {
        business_slug: "sovana-bistro",
        location_name: "Kennett Square",
        giveback_percentage: 15,
        participation_hours: "Tue–Sun 11am–9pm",
        acceptance_status: "accepted",
      },
      {
        business_slug: "the-pear",
        location_name: "Dilworthtown",
        giveback_percentage: 15,
        participation_hours: "Wed–Sun 5pm–10pm",
        acceptance_status: "accepted",
      },
    ],
  },
  {
    slug: "bayside-animal-rescue",
    campaign_name: "Dine for Paws",
    nonprofit_slug: "bayside-animal-rescue",
    campaign_story:
      "Two weeks of dining out to fund medical care, shelter, and adoption services for rescued animals across the Bay Area.",
    campaign_goal: 20000,
    campaign_start_date: "2026-05-01",
    campaign_end_date: "2026-05-14",
    campaign_status: "live",
    cover_image_url: "campaign-animals.jpg",
    raised: 12480,
    supporters_going: 312,
    expected_guests: 580,
    verified_visits: 198,
    top_event: true,
    methods: [
      {
        method_type: "dine_and_donate",
        method_name: "Dine & Donate",
        method_status: "live",
        requires_business_acceptance: true,
      },
    ],
    participants: [
      {
        business_slug: "olive-and-oak",
        location_name: "Downtown",
        giveback_percentage: 10,
        participation_hours: "All day",
        acceptance_status: "accepted",
      },
      {
        business_slug: "harbor-coffee",
        location_name: "Harbor District",
        giveback_percentage: 10,
        participation_hours: "7am–3pm",
        acceptance_status: "accepted",
      },
    ],
  },
  {
    slug: "riverdale-youth-arts",
    campaign_name: "Spring Arts Drive",
    nonprofit_slug: "riverdale-youth-arts",
    campaign_story:
      "Help us fund free art classes, supplies, and instructors for kids in our after-school program this summer.",
    campaign_goal: 15000,
    campaign_start_date: "2026-04-28",
    campaign_end_date: "2026-05-12",
    campaign_status: "live",
    cover_image_url: "campaign-arts.jpg",
    raised: 8920,
    supporters_going: 204,
    expected_guests: 410,
    verified_visits: 76,
    top_event: false,
    methods: [
      {
        method_type: "shop_and_donate",
        method_name: "Shop & Donate",
        method_status: "live",
        requires_business_acceptance: true,
      },
    ],
    participants: [
      {
        business_slug: "maker-studio",
        location_name: "Main Street",
        giveback_percentage: 8,
        participation_hours: "10am–7pm",
        acceptance_status: "accepted",
      },
    ],
  },
  {
    slug: "greenleaf-food-bank",
    campaign_name: "Fill the Table",
    nonprofit_slug: "greenleaf-food-bank",
    campaign_story:
      "Every meal at participating restaurants funds groceries for families facing food insecurity in our community.",
    campaign_goal: 30000,
    campaign_start_date: "2026-05-05",
    campaign_end_date: "2026-05-19",
    campaign_status: "live",
    cover_image_url: "campaign-foodbank.jpg",
    raised: 23150,
    supporters_going: 587,
    expected_guests: 1120,
    verified_visits: 342,
    top_event: true,
    methods: [
      {
        method_type: "dine_and_donate",
        method_name: "Dine & Donate",
        method_status: "live",
        requires_business_acceptance: true,
      },
    ],
    participants: [
      {
        business_slug: "farm-table",
        location_name: "Pearl District",
        giveback_percentage: 12,
        participation_hours: "Lunch & dinner",
        acceptance_status: "accepted",
      },
    ],
  },
];

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

export async function seed(options: DbTaskOptions & { force?: boolean } = {}) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");

    const { rows: existing } = await connection.query<QueryResultRow>(
      "SELECT COUNT(*) AS count FROM campaigns",
    );
    if (!options.force && Number(existing[0].count) > 0) {
      console.log("Campaigns already seeded, skipping.");
      await connection.query("ROLLBACK");
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
    console.log(`Seeded ${nonprofits.length} nonprofits, ${businesses.length} businesses, ${campaigns.length} campaigns.`);
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
