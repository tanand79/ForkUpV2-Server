import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";

export const profilesRouter = Router();

type NonprofitRow = QueryResultRow & {
  id: number;
  organization_name: string;
  slug: string;
  mission: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  cause_category: string | null;
  verification_status: string;
  claim_status: string;
  profile_status: string | null;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mapNonprofit(row: NonprofitRow) {
  return {
    id: row.id,
    organizationName: row.organization_name,
    slug: row.slug,
    mission: row.mission,
    website: row.website,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    causeCategory: row.cause_category,
    verificationStatus: row.verification_status,
    claimStatus: row.claim_status,
    profileStatus: row.profile_status ?? "preloaded",
    verified: row.verification_status === "verified",
  };
}

profilesRouter.get("/nonprofits/readiness", async (req, res) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim() : "";

    if (!email && !slug) {
      res.status(400).json({ error: "email or slug is required" });
      return;
    }

    const { rows: rows } = await pool.query<NonprofitRow>(
      email
        ? "SELECT * FROM nonprofits WHERE contact_email = $1 LIMIT 1"
        : "SELECT * FROM nonprofits WHERE slug = $1 LIMIT 1",
      [email || slug],
    );

    if (rows.length === 0) {
      res.json({
        state: "not_found",
        message: "No nonprofit profile found. Create or claim a profile to continue.",
        nonprofit: null,
        canSkipToCampaignBuilder: false,
        missingFields: ["organizationName", "contactEmail"],
      });
      return;
    }

    const np = rows[0];
    const missingFields: string[] = [];
    if (!np.organization_name?.trim()) missingFields.push("organizationName");
    if (!np.contact_email?.includes("@")) missingFields.push("contactEmail");
    if (!np.mission?.trim()) missingFields.push("mission");

    const isPreloadedUnclaimed =
      (np.profile_status === "preloaded" || np.claim_status === "unclaimed") &&
      np.verification_status !== "verified";

    let state: "complete" | "needs_review" | "preloaded_unclaimed" | "not_found";
    if (isPreloadedUnclaimed) state = "preloaded_unclaimed";
    else if (missingFields.length > 0) state = "needs_review";
    else state = "complete";

    res.json({
      state,
      message:
        state === "complete"
          ? "Profile is ready. Continue to campaign creation."
          : state === "preloaded_unclaimed"
            ? "Claim or confirm your preloaded nonprofit profile."
            : "Review and update your nonprofit profile before creating a campaign.",
      nonprofit: mapNonprofit(np),
      canSkipToCampaignBuilder: state === "complete",
      missingFields,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to check organization readiness" });
  }
});

/** Normalize a website URL to a domain for lookup matching. */
function normalizeWebsiteDomain(raw: string): string {
  let url = raw.trim().toLowerCase();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] ?? "";
  }
}

/**
 * Organization lookup by website — returns candidates for user confirmation.
 * Never auto-confirms identity; the client must show a confirmation screen.
 *
 * TODO: Integrate external org data providers when available.
 */
profilesRouter.get("/nonprofits/lookup", async (req, res) => {
  try {
    const website =
      typeof req.query.website === "string" ? req.query.website.trim() : "";
    if (!website) {
      res.status(400).json({ error: "website is required" });
      return;
    }

    const domain = normalizeWebsiteDomain(website);
    if (!domain) {
      res.status(400).json({ error: "Enter a valid website URL" });
      return;
    }

    const domainPattern = `%${domain}%`;
    const { rows: rows } = await pool.query<NonprofitRow>(
      `SELECT * FROM nonprofits
       WHERE website IS NOT NULL
         AND (
           LOWER(website) LIKE $1
           OR LOWER(website) LIKE $2
           OR LOWER(slug) LIKE $3
         )
       ORDER BY organization_name
       LIMIT 10`,
      [domainPattern, `%www.${domain}%`, `%${domain.split(".")[0]}%`],
    );

    const candidates = rows.map((row) => ({
      ...mapNonprofit(row),
      dataSource: "forkup_database" as const,
      location: row.cause_category ?? null,
      logoUrl: null as string | null,
    }));

    res.json({
      query: website,
      normalizedDomain: domain,
      matchCount: candidates.length,
      candidates,
      /** Explicit flag — client must never skip confirmation. */
      requiresConfirmation: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to lookup organization" });
  }
});

profilesRouter.get("/nonprofits", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params: string[] = [];
    let where = "WHERE 1=1";
    if (q) {
      where += " AND (organization_name ILIKE $1 OR slug ILIKE $2 OR contact_email ILIKE $3)";
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const { rows: rows } = await pool.query<NonprofitRow>(
      `SELECT * FROM nonprofits ${where} ORDER BY organization_name LIMIT 50`,
      params,
    );
    res.json(rows.map(mapNonprofit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch nonprofits" });
  }
});

profilesRouter.get("/nonprofits/:slug", async (req, res) => {
  try {
    const { rows: rows } = await pool.query<NonprofitRow>(
      "SELECT * FROM nonprofits WHERE slug = $1 LIMIT 1",
      [req.params.slug],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Nonprofit not found" });
      return;
    }
    res.json(mapNonprofit(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch nonprofit" });
  }
});

profilesRouter.post("/nonprofits/claim", async (req, res) => {
  try {
    const body = req.body as {
      organizationName?: string;
      contactName?: string;
      contactEmail?: string;
      mission?: string;
      causeCategory?: string;
      website?: string;
      existingSlug?: string;
    };

    if (!body.organizationName?.trim()) {
      res.status(400).json({ error: "Organization name is required" });
      return;
    }
    if (!body.contactEmail?.includes("@")) {
      res.status(400).json({ error: "Valid contact email is required" });
      return;
    }

    const email = body.contactEmail.trim().toLowerCase();
    const slug = body.existingSlug?.trim() || slugify(body.organizationName);

    const { rows: existing } = await pool.query<NonprofitRow>(
      "SELECT * FROM nonprofits WHERE slug = $1 OR contact_email = $2 LIMIT 1",
      [slug, email],
    );

    if (existing.length > 0) {
      const row = existing[0];
      await pool.query(
        `UPDATE nonprofits SET
          organization_name = $1,
          contact_name = COALESCE($2, contact_name),
          contact_email = $3,
          mission = COALESCE($4, mission),
          cause_category = COALESCE($5, cause_category),
          website = COALESCE($6, website),
          claim_status = 'claimed',
          profile_status = 'claimed',
          claim_date = COALESCE(claim_date, NOW()),
          updated_at = NOW()
         WHERE id = $7`,
        [
          body.organizationName.trim(),
          body.contactName?.trim() ?? null,
          email,
          body.mission ?? null,
          body.causeCategory ?? null,
          body.website ?? null,
          row.id,
        ],
      );
      const { rows: updated } = await pool.query<NonprofitRow>(
        "SELECT * FROM nonprofits WHERE id = $1",
        [row.id],
      );
      res.json({ action: "claimed", nonprofit: mapNonprofit(updated[0]) });
      return;
    }

    const { rows: result } = await pool.query<{ id: number }>(
      `INSERT INTO nonprofits (
        organization_name, slug, mission, cause_category, website,
        contact_name, contact_email, verification_status, claim_status, profile_status, claim_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'unclaimed', 'claimed', 'claimed', NOW()) RETURNING id`,
      [
        body.organizationName.trim(),
        slug,
        body.mission ?? null,
        body.causeCategory ?? null,
        body.website ?? null,
        body.contactName?.trim() ?? body.organizationName.trim(),
        email,
      ],
    );

    const { rows: created } = await pool.query<NonprofitRow>(
      "SELECT * FROM nonprofits WHERE id = $1",
      [result[0].id],
    );
    res.status(201).json({ action: "created", nonprofit: mapNonprofit(created[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to claim or create nonprofit profile" });
  }
});

type BusinessRow = QueryResultRow & {
  id: number;
  business_name: string;
  slug: string;
  business_type: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  business_status: string;
  claim_status: string;
  profile_status: string | null;
  default_giveback_percentage: number | null;
  supports_dine_and_donate: boolean;
  supports_shop_and_donate: boolean;
  supports_service_giveback: boolean;
  supports_guest_bartending: boolean;
};

function mapBusiness(row: BusinessRow, locations: QueryResultRow[] = []) {
  return {
    id: row.id,
    businessName: row.business_name,
    slug: row.slug,
    businessType: row.business_type,
    website: row.website,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    businessStatus: row.business_status,
    claimStatus: row.claim_status,
    profileStatus: row.profile_status ?? row.business_status,
    defaultGivebackPercentage: row.default_giveback_percentage != null
      ? Number(row.default_giveback_percentage)
      : 10,
    capabilities: {
      dineAndDonate: Boolean(row.supports_dine_and_donate),
      shopAndDonate: Boolean(row.supports_shop_and_donate),
      serviceGiveback: Boolean(row.supports_service_giveback),
      guestBartending: Boolean(row.supports_guest_bartending),
    },
    locations: locations.map((l) => ({
      id: l.id,
      locationName: l.location_name,
      city: l.city,
      state: l.state,
      address: l.address,
    })),
  };
}

profilesRouter.get("/businesses/readiness", async (req, res) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim() : "";

    if (!email && !slug) {
      res.status(400).json({ error: "email or slug is required" });
      return;
    }

    const { rows: rows } = await pool.query<BusinessRow>(
      email
        ? "SELECT * FROM businesses WHERE contact_email = $1 LIMIT 1"
        : "SELECT * FROM businesses WHERE slug = $1 LIMIT 1",
      [email || slug],
    );

    if (rows.length === 0) {
      res.json({
        state: "not_found",
        message: "No business profile found. Claim or create one to continue.",
        business: null,
        canProceed: false,
        missingFields: ["businessName", "contactEmail"],
      });
      return;
    }

    const biz = rows[0];
    const missingFields: string[] = [];
    if (!biz.business_name?.trim()) missingFields.push("businessName");
    if (!biz.contact_email?.includes("@")) missingFields.push("contactEmail");

    const isPreloadedUnclaimed =
      (biz.profile_status === "preloaded" || biz.claim_status === "unclaimed") &&
      biz.business_status !== "active";

    let state: "complete" | "needs_review" | "preloaded_unclaimed" | "not_found";
    if (isPreloadedUnclaimed) state = "preloaded_unclaimed";
    else if (missingFields.length > 0) state = "needs_review";
    else state = "complete";

    const { rows: locations } = await pool.query<QueryResultRow>(
      "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
      [biz.id],
    );

    res.json({
      state,
      message:
        state === "complete"
          ? "Business profile is ready."
          : state === "preloaded_unclaimed"
            ? "Claim or confirm your preloaded business profile."
            : "Review and update your business profile.",
      business: mapBusiness(biz, locations),
      canProceed: state === "complete",
      missingFields,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to check business readiness" });
  }
});

profilesRouter.get("/businesses", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params: string[] = [];
    let where = "WHERE 1=1";
    if (q) {
      where += " AND (b.business_name ILIKE $1 OR b.slug ILIKE $2 OR b.contact_email ILIKE $3)";
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const { rows: rows } = await pool.query<BusinessRow>(
      `SELECT b.* FROM businesses b ${where} ORDER BY b.business_name LIMIT 50`,
      params,
    );

    const results = [];
    for (const row of rows) {
      const { rows: locations } = await pool.query<QueryResultRow>(
        "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
        [row.id],
      );
      results.push(mapBusiness(row, locations));
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

profilesRouter.post("/businesses/claim", async (req, res) => {
  try {
    const body = req.body as {
      businessName?: string;
      contactName?: string;
      contactEmail?: string;
      businessType?: string;
      website?: string;
      existingSlug?: string;
      locationName?: string;
      city?: string;
      state?: string;
      supportsDineAndDonate?: boolean;
      supportsShopAndDonate?: boolean;
      supportsServiceGiveback?: boolean;
      supportsGuestBartending?: boolean;
    };

    if (!body.businessName?.trim()) {
      res.status(400).json({ error: "Business name is required" });
      return;
    }
    if (!body.contactEmail?.includes("@")) {
      res.status(400).json({ error: "Valid contact email is required" });
      return;
    }

    const email = body.contactEmail.trim().toLowerCase();
    const slug = body.existingSlug?.trim() || slugify(body.businessName);

    const { rows: existing } = await pool.query<BusinessRow>(
      "SELECT * FROM businesses WHERE slug = $1 OR contact_email = $2 LIMIT 1",
      [slug, email],
    );

    if (existing.length > 0) {
      const row = existing[0];
      await pool.query(
        `UPDATE businesses SET
          business_name = $1,
          contact_name = COALESCE($2, contact_name),
          contact_email = $3,
          business_type = COALESCE($4, business_type),
          website = COALESCE($5, website),
          supports_dine_and_donate = COALESCE($6, supports_dine_and_donate),
          supports_shop_and_donate = COALESCE($7, supports_shop_and_donate),
          supports_service_giveback = COALESCE($8, supports_service_giveback),
          supports_guest_bartending = COALESCE($9, supports_guest_bartending),
          claim_status = 'claimed',
          business_status = 'active',
          profile_status = 'claimed',
          claim_date = COALESCE(claim_date, NOW()),
          updated_at = NOW()
         WHERE id = $10`,
        [
          body.businessName.trim(),
          body.contactName?.trim() ?? null,
          email,
          body.businessType ?? null,
          body.website ?? null,
          body.supportsDineAndDonate ? true : row.supports_dine_and_donate,
          body.supportsShopAndDonate ? true : row.supports_shop_and_donate,
          body.supportsServiceGiveback ? true : row.supports_service_giveback,
          body.supportsGuestBartending ? true : row.supports_guest_bartending,
          row.id,
        ],
      );

      const { rows: locCount } = await pool.query<QueryResultRow>(
        "SELECT COUNT(*) AS c FROM business_locations WHERE business_id = $1",
        [row.id],
      );
      if (Number(locCount[0]?.c ?? 0) === 0) {
        await pool.query(
          `INSERT INTO business_locations (business_id, location_name, city, state)
           VALUES ($1, $2, $3, $4)`,
          [
            row.id,
            body.locationName?.trim() || "Main Location",
            body.city?.trim() || "TBD",
            body.state?.trim() || "TBD",
          ],
        );
      }

      const { rows: updated } = await pool.query<BusinessRow>(
        "SELECT * FROM businesses WHERE id = $1",
        [row.id],
      );
      const { rows: locations } = await pool.query<QueryResultRow>(
        "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
        [row.id],
      );
      res.json({ action: "claimed", business: mapBusiness(updated[0], locations) });
      return;
    }

    const { rows: result } = await pool.query<{ id: number }>(
      `INSERT INTO businesses (
        business_name, slug, business_type, website, contact_name, contact_email,
        business_status, claim_status, profile_status,
        supports_dine_and_donate, supports_shop_and_donate,
        supports_service_giveback, supports_guest_bartending
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 'claimed', 'claimed', $7, $8, $9, $10) RETURNING id`,
      [
        body.businessName.trim(),
        slug,
        body.businessType ?? null,
        body.website ?? null,
        body.contactName?.trim() ?? body.businessName.trim(),
        email,
        Boolean(body.supportsDineAndDonate),
        Boolean(body.supportsShopAndDonate),
        Boolean(body.supportsServiceGiveback),
        Boolean(body.supportsGuestBartending),
      ],
    );

    await pool.query(
      `INSERT INTO business_locations (business_id, location_name, city, state)
       VALUES ($1, $2, $3, $4)`,
      [
        result[0].id,
        body.locationName?.trim() || "Main Location",
        body.city?.trim() || "TBD",
        body.state?.trim() || "TBD",
      ],
    );

    const { rows: created } = await pool.query<BusinessRow>(
      "SELECT * FROM businesses WHERE id = $1",
      [result[0].id],
    );
    const { rows: locations } = await pool.query<QueryResultRow>(
      "SELECT * FROM business_locations WHERE business_id = $1",
      [result[0].id],
    );
    res.status(201).json({ action: "created", business: mapBusiness(created[0], locations) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to claim or create business profile" });
  }
});

profilesRouter.get("/businesses/:slug", async (req, res) => {
  try {
    const { rows: bizRows } = await pool.query<QueryResultRow>(
      "SELECT * FROM businesses WHERE slug = $1 LIMIT 1",
      [req.params.slug],
    );
    if (bizRows.length === 0) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const biz = bizRows[0];
    const { rows: locations } = await pool.query<QueryResultRow>(
      "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
      [biz.id],
    );
    res.json({
      id: biz.id,
      businessName: biz.business_name,
      slug: biz.slug,
      businessType: biz.business_type,
      website: biz.website,
      contactEmail: biz.contact_email,
      profileStatus: biz.profile_status ?? biz.business_status,
      locations: locations.map((l) => ({
        id: l.id,
        locationName: l.location_name,
        city: l.city,
        state: l.state,
        address: l.address,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch business" });
  }
});
