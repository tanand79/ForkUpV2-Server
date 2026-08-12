import { Router } from "express";
import type { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { sendEmail, resolveFrontendBaseUrl } from "../lib/mailer";
import {
  nearbyKeepDecision,
  parseLatLng,
  parseRadiusMiles,
} from "../lib/geo-distance";

export const profilesRouter = Router();

type NonprofitRow = QueryResultRow & {
  id: number;
  organization_name: string;
  slug: string;
  logo_url?: string | null;
  mission: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  cause_category: string | null;
  ein: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude?: number | null;
  longitude?: number | null;
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
    ein: row.ein ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
    /** Present when geo columns are populated (nearby filter support). */
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    verificationStatus: row.verification_status,
    claimStatus: row.claim_status,
    profileStatus: row.profile_status ?? "preloaded",
    verified: row.verification_status === "verified",
    logoUrl: row.logo_url ?? null,
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
    else if (np.verification_status === "needs_review") state = "needs_review";
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

/** Extract the domain portion of an email address (lowercased). */
function emailDomain(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "";
  return email.split("@")[1]?.trim().toLowerCase() ?? "";
}

/** Extract a normalized domain from a stored website value. */
function websiteDomain(website: string | null | undefined): string {
  if (!website) return "";
  return normalizeWebsiteDomain(website);
}

type MatchStrength = "strong" | "partial" | "weak";

/** Reduce an EIN to digits only for tolerant comparison (e.g. "12-3456789"). */
function normalizeEin(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\D/g, "");
}

type SearchTerms = { q: string; domain: string; ein: string; location: string };

/**
 * Score how confidently a nonprofit row matches the user's query terms.
 * Any single strong signal (exact name/slug, exact domain, exact EIN) wins.
 */
function computeMatchStrength(row: NonprofitRow, terms: SearchTerms): MatchStrength {
  const name = (row.organization_name ?? "").toLowerCase().trim();
  const slug = (row.slug ?? "").toLowerCase().trim();
  const rowDomain = websiteDomain(row.website);
  const rowEin = normalizeEin(row.ein);
  const qn = terms.q.toLowerCase().trim();
  const loc = terms.location.toLowerCase().trim();
  const rowLocation = [row.city, row.state, row.zip]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Strong signals
  if (terms.ein && rowEin && rowEin === terms.ein) return "strong";
  if (qn && (name === qn || slug === qn)) return "strong";
  if (terms.domain && rowDomain && rowDomain === terms.domain) return "strong";

  // Partial signals
  if (qn && (name.includes(qn) || qn.includes(name) || slug.includes(qn))) return "partial";
  if (terms.domain && rowDomain && (rowDomain.includes(terms.domain) || terms.domain.includes(rowDomain)))
    return "partial";
  if (terms.domain && slug.includes(terms.domain.split(".")[0] ?? "")) return "partial";
  if (loc && rowLocation && (rowLocation.includes(loc) || loc.includes(rowLocation))) return "partial";

  // Weak signals
  if (qn) {
    const tokens = qn.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.some((t) => name.includes(t))) return "weak";
  }
  if (loc && rowLocation) {
    const locTokens = loc.split(/\s+/).filter((t) => t.length > 1);
    if (locTokens.some((t) => rowLocation.includes(t))) return "weak";
  }
  return "weak";
}

const STRENGTH_RANK: Record<MatchStrength, number> = { strong: 0, partial: 1, weak: 2 };

/**
 * Data-backed "business website" check: does this domain belong to a known
 * business? Used to warn a user who enters a business site while claiming a
 * nonprofit. Returns the matching business summary or null.
 */
async function findBusinessByDomain(domain: string) {
  if (!domain) return null;
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT id, business_name, slug FROM businesses
     WHERE website IS NOT NULL AND LOWER(website) LIKE $1
     ORDER BY business_name LIMIT 1`,
    [`%${domain}%`],
  );
  const row = rows[0];
  return row
    ? { id: Number(row.id), businessName: String(row.business_name), slug: String(row.slug) }
    : null;
}

/**
 * Best-effort internal alert to FORKUP_ADMIN_EMAIL when a medium/high-risk
 * request lands. sendEmail never throws, so this cannot break the claim flow.
 */
async function notifyAdminOfAccessRequest(params: {
  organizationType: "nonprofit" | "business";
  organizationId: number | null;
  organizationName: string;
  requestType: "claim" | "access";
  riskLevel: "low" | "medium" | "high";
  requesterName: string | null;
  requesterEmail: string | null;
  riskReason: string | null;
}): Promise<void> {
  const adminEmail = process.env.FORKUP_ADMIN_EMAIL?.trim();
  if (!adminEmail) return;
  const baseUrl = resolveFrontendBaseUrl();
  await sendEmail({
    to: adminEmail,
    subject: `[Internal] ${params.riskLevel.toUpperCase()} ${params.requestType} request — ${params.organizationName}`,
    body:
      `A new ${params.riskLevel}-risk ${params.requestType} request needs review.\n\n` +
      `Organization: ${params.organizationName} (${params.organizationType}` +
      `${params.organizationId ? ` #${params.organizationId}` : ""})\n` +
      `Requester: ${params.requesterName ?? "—"} <${params.requesterEmail ?? "—"}>\n` +
      `Reason: ${params.riskReason ?? "—"}\n\n` +
      `Review it in the ForkUp Trust & Verification Queue: ${baseUrl}\n`,
    emailType: "trust_request_internal",
    stakeholderRole: "admin",
  });
}

/** Record an access/claim request for later ForkUp-admin review. */
async function logNonprofitAccessRequest(params: {
  organizationId: number | null;
  organizationName: string;
  requestType: "claim" | "access";
  riskLevel: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied";
  requestedByUserId: number | null;
  requesterName: string | null;
  requesterEmail: string | null;
  relationship: string | null;
  riskReason: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO organization_access_requests (
      organization_type, organization_id, organization_name, request_type,
      risk_level, status, requested_by_user_id, requester_name, requester_email,
      relationship, risk_reason
    ) VALUES ('nonprofit', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      params.organizationId,
      params.organizationName,
      params.requestType,
      params.riskLevel,
      params.status,
      params.requestedByUserId,
      params.requesterName,
      params.requesterEmail,
      params.relationship,
      params.riskReason,
    ],
  );
  await notifyAdminOfAccessRequest({
    organizationType: "nonprofit",
    organizationId: params.organizationId,
    organizationName: params.organizationName,
    requestType: params.requestType,
    riskLevel: params.riskLevel,
    requesterName: params.requesterName,
    requesterEmail: params.requesterEmail,
    riskReason: params.riskReason,
  });
}

/** Record a business access/claim request for later ForkUp-admin review. */
async function logBusinessAccessRequest(params: {
  organizationId: number | null;
  organizationName: string;
  requestType: "claim" | "access";
  riskLevel: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied";
  requestedByUserId: number | null;
  requesterName: string | null;
  requesterEmail: string | null;
  relationship: string | null;
  riskReason: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO organization_access_requests (
      organization_type, organization_id, organization_name, request_type,
      risk_level, status, requested_by_user_id, requester_name, requester_email,
      relationship, risk_reason
    ) VALUES ('business', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      params.organizationId,
      params.organizationName,
      params.requestType,
      params.riskLevel,
      params.status,
      params.requestedByUserId,
      params.requesterName,
      params.requesterEmail,
      params.relationship,
      params.riskReason,
    ],
  );
  await notifyAdminOfAccessRequest({
    organizationType: "business",
    organizationId: params.organizationId,
    organizationName: params.organizationName,
    requestType: params.requestType,
    riskLevel: params.riskLevel,
    requesterName: params.requesterName,
    requesterEmail: params.requesterEmail,
    riskReason: params.riskReason,
  });
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

/**
 * Unified "Find your organization" search by name and/or website.
 * Returns candidates each annotated with a match strength (strong/partial/weak),
 * sorted strongest-first, plus an optional business-website warning.
 *
 * Optional nearby filter (additive):
 *   query: lat, lng, radiusMiles? (default 8)
 *   When lat+lng are present: STRICT — only rows with coordinates within radius.
 *   Rows with NULL coords are hidden while GPS filter is active.
 *   Sorted by match strength, then nearest first when distance is known.
 */
profilesRouter.get("/nonprofits/search", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const website = typeof req.query.website === "string" ? req.query.website.trim() : "";
    const einRaw = typeof req.query.ein === "string" ? req.query.ein.trim() : "";
    const location = typeof req.query.location === "string" ? req.query.location.trim() : "";
    const origin = parseLatLng(req.query.lat, req.query.lng);
    const radiusMiles = parseRadiusMiles(req.query.radiusMiles);

    if (!q && !website && !einRaw && !location) {
      res.status(400).json({ error: "q, website, ein, or location is required" });
      return;
    }

    const domain = website ? normalizeWebsiteDomain(website) : "";
    const ein = normalizeEin(einRaw);
    const clauses: string[] = [];
    const params: string[] = [];

    if (q) {
      const like = `%${q}%`;
      params.push(like, like, like);
      clauses.push(
        `(organization_name ILIKE $${params.length - 2} OR slug ILIKE $${params.length - 1} OR contact_email ILIKE $${params.length})`,
      );
    }
    if (domain) {
      params.push(`%${domain}%`);
      clauses.push(`LOWER(website) LIKE $${params.length}`);
      params.push(`%${domain.split(".")[0] ?? ""}%`);
      clauses.push(`LOWER(slug) LIKE $${params.length}`);
    }
    if (ein) {
      params.push(`%${ein}%`);
      clauses.push(`REGEXP_REPLACE(COALESCE(ein, ''), '\\D', '', 'g') LIKE $${params.length}`);
    }
    if (location) {
      const locLike = `%${location}%`;
      params.push(locLike, locLike, locLike);
      clauses.push(
        `(city ILIKE $${params.length - 2} OR state ILIKE $${params.length - 1} OR zip ILIKE $${params.length})`,
      );
    }

    // Name + location together = narrow (e.g. org name + ZIP).
    // Only AND when those are the sole clauses; otherwise keep OR for website/EIN mixes.
    const joinOp =
      q && location && clauses.length === 2 ? " AND " : " OR ";
    const where = clauses.length ? `WHERE ${clauses.join(joinOp)}` : "WHERE 1=1";
    const { rows: rows } = await pool.query<NonprofitRow>(
      `SELECT * FROM nonprofits ${where} ORDER BY organization_name LIMIT 25`,
      params,
    );

    const terms: SearchTerms = { q, domain, ein, location };
    const candidates = rows
      .map((row) => {
        // Soft nearby: drop only mapped rows outside radius; unmapped rows stay.
        const nearby = nearbyKeepDecision(
          origin,
          row.latitude,
          row.longitude,
          radiusMiles,
          { requireCoordinates: false },
        );
        return {
          ...mapNonprofit(row),
          matchStrength: computeMatchStrength(row, terms),
          distanceMiles: nearby.distanceMiles,
          _nearbyKeep: nearby.keep,
        };
      })
      .filter((c) => c._nearbyKeep)
      .map(({ _nearbyKeep: _drop, ...rest }) => rest)
      .sort((a, b) => {
        const strengthDiff =
          STRENGTH_RANK[a.matchStrength] - STRENGTH_RANK[b.matchStrength];
        if (strengthDiff !== 0) return strengthDiff;
        const da = a.distanceMiles;
        const db = b.distanceMiles;
        if (da != null && db != null) return da - db;
        if (da != null) return -1;
        if (db != null) return 1;
        return 0;
      });

    const businessWarning = domain ? await findBusinessByDomain(domain) : null;

    res.json({
      query: q,
      website,
      ein: einRaw,
      location,
      normalizedDomain: domain || null,
      matchCount: candidates.length,
      candidates,
      businessWarning,
      requiresConfirmation: true,
      nearby: origin
        ? {
            latitude: origin.latitude,
            longitude: origin.longitude,
            radiusMiles,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to search organizations" });
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

/**
 * Trust-gated claim / request-access for nonprofits.
 *
 * Trust levels:
 *  - low     -> auto-ready: claim proceeds normally.
 *  - medium  -> profile saved but flagged verification_status='needs_review'
 *               (launch/settlement gating is enforced downstream); logged for review.
 *  - high    -> org already claimed by another user: NOT modified; an access
 *               request is recorded for ForkUp-admin review.
 *
 * This is additive and separate from POST /nonprofits/claim (unchanged).
 */
profilesRouter.post("/nonprofits/claim-request", async (req, res) => {
  try {
    const body = req.body as {
      organizationName?: string;
      contactName?: string;
      contactEmail?: string;
      mission?: string;
      causeCategory?: string;
      website?: string;
      existingSlug?: string;
      relationship?: string;
      ein?: string;
      city?: string;
      state?: string;
      zip?: string;
    };

    if (!body.organizationName?.trim()) {
      res.status(400).json({ error: "Organization name is required" });
      return;
    }
    if (!body.contactEmail?.includes("@")) {
      res.status(400).json({ error: "Valid contact email is required" });
      return;
    }

    const authUser = await resolveAuthUser(bearerToken(req));
    const requestedByUserId = authUser?.id ?? null;

    const email = body.contactEmail.trim().toLowerCase();
    const requesterEmailDomain = emailDomain(email);
    const providedDomain = websiteDomain(body.website);
    const relationship = body.relationship?.trim() || null;
    const requesterName = body.contactName?.trim() || null;
    const ein = body.ein?.trim() || null;
    const city = body.city?.trim() || null;
    const stateValue = body.state?.trim() || null;
    const zip = body.zip?.trim() || null;

    const businessWarning = providedDomain ? await findBusinessByDomain(providedDomain) : null;

    type ClaimRow = NonprofitRow & { claimed_by_user_id: number | null };

    // --- Claiming an existing organization ---
    if (body.existingSlug?.trim()) {
      const { rows: existing } = await pool.query<ClaimRow>(
        "SELECT * FROM nonprofits WHERE slug = $1 LIMIT 1",
        [body.existingSlug.trim()],
      );
      if (existing.length === 0) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      const org = existing[0];
      const alreadyClaimedByOther =
        org.claim_status === "claimed" &&
        org.claimed_by_user_id != null &&
        org.claimed_by_user_id !== requestedByUserId;

      // HIGH risk: already claimed by someone else -> do not modify, queue review.
      if (alreadyClaimedByOther) {
        await logNonprofitAccessRequest({
          organizationId: org.id,
          organizationName: org.organization_name,
          requestType: "access",
          riskLevel: "high",
          status: "pending",
          requestedByUserId,
          requesterName,
          requesterEmail: email,
          relationship,
          riskReason: "Organization already claimed by another user",
        });
        res.status(202).json({
          action: "access_requested",
          riskLevel: "high",
          nonprofit: mapNonprofit(org),
          businessWarning,
          message:
            "This organization is already claimed. Your access request has been submitted for ForkUp review.",
        });
        return;
      }

      const orgDomain = websiteDomain(org.website) || providedDomain;
      const domainMatch =
        Boolean(requesterEmailDomain) && Boolean(orgDomain) && requesterEmailDomain === orgDomain;
      const riskLevel: "low" | "medium" = domainMatch ? "low" : "medium";

      await pool.query(
        `UPDATE nonprofits SET
          organization_name = $1,
          contact_name = COALESCE($2, contact_name),
          contact_email = $3,
          mission = COALESCE($4, mission),
          cause_category = COALESCE($5, cause_category),
          website = COALESCE($6, website),
          ein = COALESCE($7, ein),
          city = COALESCE($8, city),
          state = COALESCE($9, state),
          zip = COALESCE($10, zip),
          claim_status = 'claimed',
          profile_status = 'claimed',
          verification_status = CASE WHEN $11 = 'medium' THEN 'needs_review' ELSE verification_status END,
          claimed_by_user_id = COALESCE($12, claimed_by_user_id),
          claim_date = COALESCE(claim_date, NOW()),
          updated_at = NOW()
         WHERE id = $13`,
        [
          body.organizationName.trim(),
          requesterName,
          email,
          body.mission ?? null,
          body.causeCategory ?? null,
          body.website ?? null,
          ein,
          city,
          stateValue,
          zip,
          riskLevel,
          requestedByUserId,
          org.id,
        ],
      );

      if (riskLevel === "medium") {
        await logNonprofitAccessRequest({
          organizationId: org.id,
          organizationName: body.organizationName.trim(),
          requestType: "claim",
          riskLevel: "medium",
          status: "pending",
          requestedByUserId,
          requesterName,
          requesterEmail: email,
          relationship,
          riskReason: "Contact email domain does not match organization website",
        });
      }

      const { rows: updated } = await pool.query<NonprofitRow>(
        "SELECT * FROM nonprofits WHERE id = $1",
        [org.id],
      );
      res.json({
        action: riskLevel === "medium" ? "claimed_pending_verification" : "claimed",
        riskLevel,
        nonprofit: mapNonprofit(updated[0]),
        businessWarning,
      });
      return;
    }

    // --- Creating a new organization ---
    const slug = slugify(body.organizationName);
    const { rows: slugTaken } = await pool.query<ClaimRow>(
      "SELECT * FROM nonprofits WHERE slug = $1 OR contact_email = $2 LIMIT 1",
      [slug, email],
    );
    if (slugTaken.length > 0) {
      // An org with this slug/email already exists — treat as an existing-org claim
      // to avoid unique-constraint errors. Re-route through the existing-slug branch.
      res.status(409).json({
        error: "An organization with this name or email already exists",
        existingSlug: slugTaken[0].slug,
      });
      return;
    }

    const domainMatch =
      Boolean(requesterEmailDomain) && Boolean(providedDomain) && requesterEmailDomain === providedDomain;
    const riskLevel: "low" | "medium" = domainMatch ? "low" : "medium";

    const { rows: result } = await pool.query<{ id: number }>(
      `INSERT INTO nonprofits (
        organization_name, slug, mission, cause_category, website,
        ein, city, state, zip,
        contact_name, contact_email, verification_status, claim_status, profile_status,
        claimed_by_user_id, claim_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'claimed', 'claimed', $13, NOW()) RETURNING id`,
      [
        body.organizationName.trim(),
        slug,
        body.mission ?? null,
        body.causeCategory ?? null,
        body.website ?? null,
        ein,
        city,
        stateValue,
        zip,
        requesterName ?? body.organizationName.trim(),
        email,
        riskLevel === "medium" ? "needs_review" : "unclaimed",
        requestedByUserId,
      ],
    );

    if (riskLevel === "medium") {
      await logNonprofitAccessRequest({
        organizationId: result[0].id,
        organizationName: body.organizationName.trim(),
        requestType: "claim",
        riskLevel: "medium",
        status: "pending",
        requestedByUserId,
        requesterName,
        requesterEmail: email,
        relationship,
        riskReason: "New organization created with a non-matching or missing website domain",
      });
    }

    const { rows: created } = await pool.query<NonprofitRow>(
      "SELECT * FROM nonprofits WHERE id = $1",
      [result[0].id],
    );
    res.status(201).json({
      action: riskLevel === "medium" ? "created_pending_verification" : "created",
      riskLevel,
      nonprofit: mapNonprofit(created[0]),
      businessWarning,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process claim or access request" });
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

/**
 * Trust-gated claim / request-access for businesses — the symmetric counterpart
 * of POST /nonprofits/claim-request.
 *
 * Trust levels:
 *  - low     -> auto-ready: claim proceeds normally.
 *  - medium  -> profile saved but flagged claim_status='needs_review'; logged
 *               for ForkUp-admin review (businesses have no separate
 *               verification_status, so claim_status carries the review flag).
 *  - high    -> business already claimed by another user: NOT modified; an
 *               access request is recorded for ForkUp-admin review.
 *
 * This is additive and separate from POST /businesses/claim (unchanged).
 */
profilesRouter.post("/businesses/claim-request", async (req, res) => {
  try {
    const body = req.body as {
      businessName?: string;
      contactName?: string;
      contactEmail?: string;
      businessType?: string;
      website?: string;
      existingSlug?: string;
      relationship?: string;
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

    const authUser = await resolveAuthUser(bearerToken(req));
    const requestedByUserId = authUser?.id ?? null;

    const email = body.contactEmail.trim().toLowerCase();
    const requesterEmailDomain = emailDomain(email);
    const providedDomain = websiteDomain(body.website);
    const relationship = body.relationship?.trim() || null;
    const requesterName = body.contactName?.trim() || null;
    const slug = body.existingSlug?.trim() || slugify(body.businessName);

    type ClaimBusinessRow = BusinessRow & { claimed_by_user_id: number | null };

    const { rows: existing } = await pool.query<ClaimBusinessRow>(
      "SELECT * FROM businesses WHERE slug = $1 OR contact_email = $2 LIMIT 1",
      [slug, email],
    );

    // --- Claiming / updating an existing business ---
    if (existing.length > 0) {
      const biz = existing[0];
      const alreadyClaimedByOther =
        biz.claim_status === "claimed" &&
        biz.claimed_by_user_id != null &&
        biz.claimed_by_user_id !== requestedByUserId;

      // HIGH risk: already claimed by someone else -> do not modify, queue review.
      if (alreadyClaimedByOther) {
        await logBusinessAccessRequest({
          organizationId: biz.id,
          organizationName: biz.business_name,
          requestType: "access",
          riskLevel: "high",
          status: "pending",
          requestedByUserId,
          requesterName,
          requesterEmail: email,
          relationship,
          riskReason: "Business already claimed by another user",
        });
        const { rows: locations } = await pool.query<QueryResultRow>(
          "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
          [biz.id],
        );
        res.status(202).json({
          action: "access_requested",
          riskLevel: "high",
          business: mapBusiness(biz, locations),
          message:
            "This business is already claimed. Your access request has been submitted for ForkUp review.",
        });
        return;
      }

      const orgDomain = websiteDomain(biz.website) || providedDomain;
      const domainMatch =
        Boolean(requesterEmailDomain) && Boolean(orgDomain) && requesterEmailDomain === orgDomain;
      const riskLevel: "low" | "medium" = domainMatch ? "low" : "medium";

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
          claim_status = CASE WHEN $10 = 'medium' THEN 'needs_review' ELSE 'claimed' END,
          business_status = 'active',
          profile_status = 'claimed',
          claimed_by_user_id = COALESCE($11, claimed_by_user_id),
          claim_date = COALESCE(claim_date, NOW()),
          updated_at = NOW()
         WHERE id = $12`,
        [
          body.businessName.trim(),
          requesterName,
          email,
          body.businessType ?? null,
          body.website ?? null,
          body.supportsDineAndDonate ? true : biz.supports_dine_and_donate,
          body.supportsShopAndDonate ? true : biz.supports_shop_and_donate,
          body.supportsServiceGiveback ? true : biz.supports_service_giveback,
          body.supportsGuestBartending ? true : biz.supports_guest_bartending,
          riskLevel,
          requestedByUserId,
          biz.id,
        ],
      );

      const { rows: locCount } = await pool.query<QueryResultRow>(
        "SELECT COUNT(*) AS c FROM business_locations WHERE business_id = $1",
        [biz.id],
      );
      if (Number(locCount[0]?.c ?? 0) === 0) {
        await pool.query(
          `INSERT INTO business_locations (business_id, location_name, city, state)
           VALUES ($1, $2, $3, $4)`,
          [
            biz.id,
            body.locationName?.trim() || "Main Location",
            body.city?.trim() || "TBD",
            body.state?.trim() || "TBD",
          ],
        );
      }

      if (riskLevel === "medium") {
        await logBusinessAccessRequest({
          organizationId: biz.id,
          organizationName: body.businessName.trim(),
          requestType: "claim",
          riskLevel: "medium",
          status: "pending",
          requestedByUserId,
          requesterName,
          requesterEmail: email,
          relationship,
          riskReason: "Contact email domain does not match business website",
        });
      }

      const { rows: updated } = await pool.query<BusinessRow>(
        "SELECT * FROM businesses WHERE id = $1",
        [biz.id],
      );
      const { rows: locations } = await pool.query<QueryResultRow>(
        "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
        [biz.id],
      );
      res.json({
        action: riskLevel === "medium" ? "claimed_pending_verification" : "claimed",
        riskLevel,
        business: mapBusiness(updated[0], locations),
      });
      return;
    }

    // --- Creating a new business ---
    const domainMatch =
      Boolean(requesterEmailDomain) && Boolean(providedDomain) && requesterEmailDomain === providedDomain;
    const riskLevel: "low" | "medium" = domainMatch ? "low" : "medium";

    const { rows: result } = await pool.query<{ id: number }>(
      `INSERT INTO businesses (
        business_name, slug, business_type, website, contact_name, contact_email,
        business_status, claim_status, profile_status, claimed_by_user_id, claim_date,
        supports_dine_and_donate, supports_shop_and_donate,
        supports_service_giveback, supports_guest_bartending
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 'claimed', $8, NOW(), $9, $10, $11, $12) RETURNING id`,
      [
        body.businessName.trim(),
        slug,
        body.businessType ?? null,
        body.website ?? null,
        requesterName ?? body.businessName.trim(),
        email,
        riskLevel === "medium" ? "needs_review" : "claimed",
        requestedByUserId,
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

    if (riskLevel === "medium") {
      await logBusinessAccessRequest({
        organizationId: result[0].id,
        organizationName: body.businessName.trim(),
        requestType: "claim",
        riskLevel: "medium",
        status: "pending",
        requestedByUserId,
        requesterName,
        requesterEmail: email,
        relationship,
        riskReason: "New business created with a non-matching or missing website domain",
      });
    }

    const { rows: created } = await pool.query<BusinessRow>(
      "SELECT * FROM businesses WHERE id = $1",
      [result[0].id],
    );
    const { rows: locations } = await pool.query<QueryResultRow>(
      "SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name",
      [result[0].id],
    );
    res.status(201).json({
      action: riskLevel === "medium" ? "created_pending_verification" : "created",
      riskLevel,
      business: mapBusiness(created[0], locations),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process business claim or access request" });
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

/**
 * POST /api/profiles/access-requests/resubmit
 * Body: { organizationType: "nonprofit" | "business", organizationId: number }
 * Response: { success: true, id: number, status: "pending", organizationType, organizationId }
 *
 * Purpose: After a Super Admin denial, the requester (or linked org member) can
 * open a new pending access/claim request without changing the denied row.
 * Only allowed when the latest request for that org is status = denied.
 */
profilesRouter.post("/access-requests/resubmit", async (req, res) => {
  try {
    const authUser = await resolveAuthUser(bearerToken(req));
    if (!authUser) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    const body = req.body as {
      organizationType?: string;
      organizationId?: number;
    };
    const organizationType =
      body.organizationType === "nonprofit" || body.organizationType === "business"
        ? body.organizationType
        : null;
    const organizationId = Number(body.organizationId);
    if (!organizationType || !Number.isFinite(organizationId) || organizationId <= 0) {
      res.status(400).json({
        error: "organizationType and organizationId are required",
      });
      return;
    }

    const { rows: latestRows } = await pool.query<QueryResultRow>(
      `SELECT id, organization_name, request_type, risk_level, status,
              requested_by_user_id, requester_name, requester_email,
              relationship, risk_reason
       FROM organization_access_requests
       WHERE organization_type = $1 AND organization_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [organizationType, organizationId],
    );
    const latest = latestRows[0];
    if (!latest) {
      res.status(404).json({ error: "No access request found for this organization" });
      return;
    }
    if (latest.status === "pending") {
      res.status(409).json({ error: "A pending request already exists" });
      return;
    }
    if (latest.status !== "denied") {
      res.status(400).json({
        error: "Only a denied request can be submitted again",
      });
      return;
    }

    const wasRequester =
      latest.requested_by_user_id != null &&
      Number(latest.requested_by_user_id) === authUser.id;
    const { rows: membership } = await pool.query<QueryResultRow>(
      `SELECT 1 FROM organization_users
       WHERE organization_type = $1 AND organization_id = $2 AND user_id = $3
       LIMIT 1`,
      [organizationType, organizationId, authUser.id],
    );
    let isClaimOwner = false;
    if (organizationType === "nonprofit") {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT 1 FROM nonprofits WHERE id = $1 AND claimed_by_user_id = $2 LIMIT 1`,
        [organizationId, authUser.id],
      );
      isClaimOwner = rows.length > 0;
    } else {
      const { rows } = await pool.query<QueryResultRow>(
        `SELECT 1 FROM businesses WHERE id = $1 AND claimed_by_user_id = $2 LIMIT 1`,
        [organizationId, authUser.id],
      );
      isClaimOwner = rows.length > 0;
    }
    if (!wasRequester && membership.length === 0 && !isClaimOwner) {
      res.status(403).json({ error: "Not allowed to resubmit for this organization" });
      return;
    }

    const requestType =
      latest.request_type === "access" || latest.request_type === "claim"
        ? latest.request_type
        : "claim";
    const riskLevel =
      latest.risk_level === "low" ||
      latest.risk_level === "medium" ||
      latest.risk_level === "high"
        ? latest.risk_level
        : "medium";
    const organizationName = String(latest.organization_name ?? "Organization");
    const requesterName =
      (typeof latest.requester_name === "string" && latest.requester_name.trim()) ||
      authUser.fullName ||
      null;
    const requesterEmail =
      (typeof latest.requester_email === "string" && latest.requester_email.trim()) ||
      authUser.email ||
      null;
    const relationship =
      typeof latest.relationship === "string" ? latest.relationship : null;
    const priorReason =
      typeof latest.risk_reason === "string" && latest.risk_reason.trim()
        ? latest.risk_reason.trim()
        : null;
    const riskReason = priorReason
      ? `Resubmitted after denial. Prior reason: ${priorReason}`
      : "Resubmitted after denial";

    if (organizationType === "nonprofit") {
      await logNonprofitAccessRequest({
        organizationId,
        organizationName,
        requestType,
        riskLevel,
        status: "pending",
        requestedByUserId: authUser.id,
        requesterName,
        requesterEmail,
        relationship,
        riskReason,
      });
    } else {
      await logBusinessAccessRequest({
        organizationId,
        organizationName,
        requestType,
        riskLevel,
        status: "pending",
        requestedByUserId: authUser.id,
        requesterName,
        requesterEmail,
        relationship,
        riskReason,
      });
    }

    const { rows: created } = await pool.query<QueryResultRow>(
      `SELECT id FROM organization_access_requests
       WHERE organization_type = $1 AND organization_id = $2 AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
      [organizationType, organizationId],
    );
    const newId = created[0]?.id != null ? Number(created[0].id) : null;
    if (!newId) {
      res.status(500).json({ error: "Failed to create resubmit request" });
      return;
    }

    res.status(201).json({
      success: true,
      id: newId,
      status: "pending",
      organizationType,
      organizationId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to resubmit access request" });
  }
});
