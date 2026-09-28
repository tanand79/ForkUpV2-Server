/**
 * Persist public org links + gallery onto nonprofits (additive helpers).
 *
 * Purpose: NPO profile social / about / gallery durable saves (mirrors business venue).
 * Inputs: nonprofitId + optional public URLs / about / gallery.
 * Outputs: updated field bags or gallery URL lists.
 */
import { pool } from "../db/pool";

export type NonprofitPublicLinksUpdate = {
  website?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  tiktokUrl?: string | null;
  youtubeUrl?: string | null;
  phone?: string | null;
  contactEmail?: string | null;
  /** Maps to nonprofits.description (About section). */
  about?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  organizationName?: string | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

/**
 * Null-only fill of public profile columns (never wipe user-entered values).
 * Used after Create Campaign AI and View-profile hydrate.
 */
export async function fillNonprofitPublicProfileNullOnly(
  nonprofitId: number,
  fill: {
    website?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    youtubeUrl?: string | null;
    city?: string | null;
    state?: string | null;
    about?: string | null;
    mission?: string | null;
    logoUrl?: string | null;
  },
): Promise<void> {
  if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) return;

  const website = trimOrNull(fill.website);
  const facebookUrl = trimOrNull(fill.facebookUrl);
  const instagramUrl = trimOrNull(fill.instagramUrl);
  const linkedinUrl = trimOrNull(fill.linkedinUrl);
  const youtubeUrl = trimOrNull(fill.youtubeUrl);
  const city = trimOrNull(fill.city);
  const state = trimOrNull(fill.state);
  const about = trimOrNull(fill.about);
  const mission = trimOrNull(fill.mission);
  const logoUrl = trimOrNull(fill.logoUrl);

  if (
    !website &&
    !facebookUrl &&
    !instagramUrl &&
    !linkedinUrl &&
    !youtubeUrl &&
    !city &&
    !state &&
    !about &&
    !mission &&
    !logoUrl
  ) {
    return;
  }

  try {
    await pool.query(
      `UPDATE nonprofits SET
         website = COALESCE(NULLIF(TRIM(website), ''), $2),
         facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
         instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
         linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
         youtube_url = COALESCE(NULLIF(TRIM(youtube_url), ''), $6),
         city = COALESCE(NULLIF(TRIM(city), ''), $7),
         state = COALESCE(NULLIF(TRIM(state), ''), $8),
         description = COALESCE(NULLIF(TRIM(description), ''), $9),
         mission = COALESCE(NULLIF(TRIM(mission), ''), $10),
         logo_url = COALESCE(NULLIF(TRIM(logo_url), ''), $11),
         updated_at = NOW()
       WHERE id = $1`,
      [
        nonprofitId,
        website,
        facebookUrl,
        instagramUrl,
        linkedinUrl,
        youtubeUrl,
        city,
        state,
        about,
        mission,
        logoUrl,
      ],
    );
  } catch (err) {
    console.error("fillNonprofitPublicProfileNullOnly failed:", err);
  }
}

/** Parse nonprofits.gallery_urls JSONB into a trimmed string list. */
export function parseNonprofitGalleryUrls(raw: unknown): string[] {
  if (!raw) return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0,
  );
}

/**
 * User-edited public links — overwrites provided fields (empty string clears).
 * Fields omitted from `links` are left unchanged.
 */
export async function updateNonprofitPublicLinks(
  nonprofitId: number,
  links: NonprofitPublicLinksUpdate,
): Promise<NonprofitPublicLinksUpdate | null> {
  if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) return null;

  const sets: string[] = [];
  const params: (string | number | null)[] = [nonprofitId];
  const written: NonprofitPublicLinksUpdate = {};

  const push = (
    column: string,
    key: keyof NonprofitPublicLinksUpdate,
    value: string | null | undefined,
    present: boolean,
  ) => {
    if (!present) return;
    const clean = trimOrNull(value);
    params.push(clean);
    sets.push(`${column} = $${params.length}`);
    written[key] = clean;
  };

  push(
    "website",
    "website",
    links.website,
    Object.prototype.hasOwnProperty.call(links, "website"),
  );
  push(
    "facebook_url",
    "facebookUrl",
    links.facebookUrl,
    Object.prototype.hasOwnProperty.call(links, "facebookUrl"),
  );
  push(
    "instagram_url",
    "instagramUrl",
    links.instagramUrl,
    Object.prototype.hasOwnProperty.call(links, "instagramUrl"),
  );
  push(
    "linkedin_url",
    "linkedinUrl",
    links.linkedinUrl,
    Object.prototype.hasOwnProperty.call(links, "linkedinUrl"),
  );
  push(
    "tiktok_url",
    "tiktokUrl",
    links.tiktokUrl,
    Object.prototype.hasOwnProperty.call(links, "tiktokUrl"),
  );
  push(
    "youtube_url",
    "youtubeUrl",
    links.youtubeUrl,
    Object.prototype.hasOwnProperty.call(links, "youtubeUrl"),
  );
  push(
    "contact_phone",
    "phone",
    links.phone,
    Object.prototype.hasOwnProperty.call(links, "phone"),
  );
  push(
    "contact_email",
    "contactEmail",
    links.contactEmail,
    Object.prototype.hasOwnProperty.call(links, "contactEmail"),
  );
  push(
    "description",
    "about",
    links.about,
    Object.prototype.hasOwnProperty.call(links, "about"),
  );
  push(
    "city",
    "city",
    links.city,
    Object.prototype.hasOwnProperty.call(links, "city"),
  );
  push(
    "state",
    "state",
    links.state,
    Object.prototype.hasOwnProperty.call(links, "state"),
  );
  push(
    "zip",
    "zip",
    links.zip,
    Object.prototype.hasOwnProperty.call(links, "zip"),
  );
  push(
    "organization_name",
    "organizationName",
    links.organizationName,
    Object.prototype.hasOwnProperty.call(links, "organizationName"),
  );

  if (sets.length === 0) return {};

  try {
    await pool.query(
      `UPDATE nonprofits SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`,
      params,
    );
    return written;
  } catch (err) {
    console.error("updateNonprofitPublicLinks failed:", err);
    return null;
  }
}

/**
 * Append uploaded / user-selected gallery URLs into gallery_urls.
 * Union with existing rows; never shrinks; caps at 24.
 */
export async function mergeNonprofitGalleryUrls(
  nonprofitId: number,
  urls: string[],
): Promise<string[]> {
  if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) return [];
  const incoming = urls.map((u) => u.trim()).filter(Boolean);
  if (incoming.length === 0) {
    try {
      const { rows } = await pool.query<{ gallery_urls: unknown }>(
        `SELECT gallery_urls FROM nonprofits WHERE id = $1 LIMIT 1`,
        [nonprofitId],
      );
      return parseNonprofitGalleryUrls(rows[0]?.gallery_urls);
    } catch {
      return [];
    }
  }

  try {
    const { rows } = await pool.query<{ gallery_urls: unknown }>(
      `SELECT gallery_urls FROM nonprofits WHERE id = $1 LIMIT 1`,
      [nonprofitId],
    );
    const existing = parseNonprofitGalleryUrls(rows[0]?.gallery_urls);
    const merged = [...new Set([...existing, ...incoming])].slice(0, 24);
    await pool.query(
      `UPDATE nonprofits SET
         gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [nonprofitId, JSON.stringify(merged)],
    );
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/gallery_urls/i.test(message)) {
      console.error("mergeNonprofitGalleryUrls failed:", err);
    }
    return [];
  }
}

/**
 * Replace gallery_urls entirely (used when refreshing expired social CDN links).
 * Caps at 24. Returns the stored list.
 */
export async function replaceNonprofitGalleryUrls(
  nonprofitId: number,
  urls: string[],
): Promise<string[]> {
  if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) return [];
  const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    24,
  );
  try {
    await pool.query(
      `UPDATE nonprofits SET
         gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [nonprofitId, JSON.stringify(clean)],
    );
    return clean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/gallery_urls/i.test(message)) {
      console.error("replaceNonprofitGalleryUrls failed:", err);
    }
    return [];
  }
}

/**
 * Persist the org-chosen cover URL (user override; may replace prior).
 * Pass null/empty to clear. Returns the stored value (or null).
 */
export async function persistNonprofitCoverUrl(
  nonprofitId: number,
  coverUrl: string | null | undefined,
): Promise<string | null> {
  if (!Number.isFinite(nonprofitId) || nonprofitId <= 0) return null;
  const clean =
    typeof coverUrl === "string" && coverUrl.trim() ? coverUrl.trim() : null;
  try {
    await pool.query(
      `UPDATE nonprofits SET
         cover_url = $2,
         updated_at = NOW()
       WHERE id = $1`,
      [nonprofitId, clean],
    );
    return clean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/cover_url/i.test(message)) {
      console.error("persistNonprofitCoverUrl failed:", err);
    }
    return null;
  }
}
