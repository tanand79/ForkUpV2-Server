/**
 * Persist public venue links onto businesses (additive, null-only fill).
 *
 * Purpose: After scrape/find, store facebook/instagram/etc. so profile opens
 * without re-scraping. Never overwrites non-empty columns.
 *
 * Inputs: businessId + optional public URLs/phone/venue email.
 * Outputs: void (best-effort UPDATE).
 */
import { pool } from "../db/pool";

export type BusinessPublicLinks = {
  website?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  tiktokUrl?: string | null;
  youtubeUrl?: string | null;
  phone?: string | null;
  /** Public venue mailto — not the claim/ops contact_email. */
  venueEmail?: string | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

/**
 * Fill empty public-link columns on businesses. Skips when businessId invalid.
 * youtube is ignored until a dedicated column exists (tiktok/facebook cover social row).
 */
export async function persistBusinessPublicLinks(
  businessId: number,
  links: BusinessPublicLinks,
): Promise<void> {
  if (!Number.isFinite(businessId) || businessId <= 0) return;

  const website = trimOrNull(links.website);
  const facebookUrl = trimOrNull(links.facebookUrl);
  const instagramUrl = trimOrNull(links.instagramUrl);
  const linkedinUrl = trimOrNull(links.linkedinUrl);
  const tiktokUrl = trimOrNull(links.tiktokUrl);
  const phone = trimOrNull(links.phone);
  const venueEmail = trimOrNull(links.venueEmail);

  if (
    !website &&
    !facebookUrl &&
    !instagramUrl &&
    !linkedinUrl &&
    !tiktokUrl &&
    !phone &&
    !venueEmail
  ) {
    return;
  }

  try {
    await pool.query(
      `UPDATE businesses SET
         website = COALESCE(NULLIF(TRIM(website), ''), $2),
         facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
         instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
         linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
         tiktok_url = COALESCE(NULLIF(TRIM(tiktok_url), ''), $6),
         contact_phone = COALESCE(NULLIF(TRIM(contact_phone), ''), $7),
         venue_email = COALESCE(NULLIF(TRIM(venue_email), ''), $8),
         updated_at = NOW()
       WHERE id = $1`,
      [
        businessId,
        website,
        facebookUrl,
        instagramUrl,
        linkedinUrl,
        tiktokUrl,
        phone,
        venueEmail,
      ],
    );
  } catch (err) {
    // venue_email may not exist until migration — retry without it.
    const message = err instanceof Error ? err.message : String(err);
    if (!/venue_email/i.test(message)) {
      console.error("persistBusinessPublicLinks failed:", err);
      return;
    }
    try {
      await pool.query(
        `UPDATE businesses SET
           website = COALESCE(NULLIF(TRIM(website), ''), $2),
           facebook_url = COALESCE(NULLIF(TRIM(facebook_url), ''), $3),
           instagram_url = COALESCE(NULLIF(TRIM(instagram_url), ''), $4),
           linkedin_url = COALESCE(NULLIF(TRIM(linkedin_url), ''), $5),
           tiktok_url = COALESCE(NULLIF(TRIM(tiktok_url), ''), $6),
           contact_phone = COALESCE(NULLIF(TRIM(contact_phone), ''), $7),
           updated_at = NOW()
         WHERE id = $1`,
        [
          businessId,
          website,
          facebookUrl,
          instagramUrl,
          linkedinUrl,
          tiktokUrl,
          phone,
        ],
      );
    } catch (err2) {
      console.error("persistBusinessPublicLinks fallback failed:", err2);
    }
  }
}

export type BusinessPublicLinksUpdate = {
  website?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  tiktokUrl?: string | null;
  phone?: string | null;
  venueEmail?: string | null;
};

/**
 * User-edited public links — overwrites provided fields (empty string clears).
 * Fields omitted from `links` are left unchanged.
 * Returns the stored values for the fields that were written.
 */
export async function updateBusinessPublicLinks(
  businessId: number,
  links: BusinessPublicLinksUpdate,
): Promise<BusinessPublicLinksUpdate | null> {
  if (!Number.isFinite(businessId) || businessId <= 0) return null;

  const sets: string[] = [];
  const params: (string | number | null)[] = [businessId];
  const written: BusinessPublicLinksUpdate = {};

  const push = (
    column: string,
    key: keyof BusinessPublicLinksUpdate,
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
    "contact_phone",
    "phone",
    links.phone,
    Object.prototype.hasOwnProperty.call(links, "phone"),
  );
  push(
    "venue_email",
    "venueEmail",
    links.venueEmail,
    Object.prototype.hasOwnProperty.call(links, "venueEmail"),
  );

  if (sets.length === 0) return {};

  try {
    await pool.query(
      `UPDATE businesses SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`,
      params,
    );
    return written;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // venue_email may be missing on older DBs — retry without that column.
    if (
      /venue_email/i.test(message) &&
      Object.prototype.hasOwnProperty.call(links, "venueEmail")
    ) {
      const { venueEmail: _drop, ...rest } = links;
      return updateBusinessPublicLinks(businessId, rest);
    }
    console.error("updateBusinessPublicLinks failed:", err);
    return null;
  }
}

/**
 * Persist venue gallery photo URLs (null/empty only — never wipe a richer set).
 * Inputs: businessId, absolute image URL list.
 */
export async function persistBusinessGalleryUrls(
  businessId: number,
  urls: string[],
): Promise<void> {
  if (!Number.isFinite(businessId) || businessId <= 0) return;
  const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 24);
  if (clean.length === 0) return;
  try {
    await pool.query(
      `UPDATE businesses SET
         venue_gallery_urls = CASE
           WHEN venue_gallery_urls IS NULL
             OR jsonb_typeof(venue_gallery_urls) <> 'array'
             OR jsonb_array_length(venue_gallery_urls) = 0
           THEN $2::jsonb
           WHEN jsonb_array_length(venue_gallery_urls) < $3
           THEN $2::jsonb
           ELSE venue_gallery_urls
         END,
         updated_at = NOW()
       WHERE id = $1`,
      [businessId, JSON.stringify(clean), clean.length],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/venue_gallery_urls/i.test(message)) {
      console.error("persistBusinessGalleryUrls failed:", err);
    }
  }
}

/** Parse businesses.venue_gallery_urls JSONB into a trimmed string list. */
function parseGalleryUrls(raw: unknown): string[] {
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
 * Append uploaded / user-selected gallery URLs into venue_gallery_urls.
 * Union with existing rows; never shrinks; caps at 24.
 * Returns the merged list after write (or existing list on failure).
 */
export async function mergeBusinessGalleryUrls(
  businessId: number,
  urls: string[],
): Promise<string[]> {
  if (!Number.isFinite(businessId) || businessId <= 0) return [];
  const incoming = urls.map((u) => u.trim()).filter(Boolean);
  if (incoming.length === 0) {
    try {
      const { rows } = await pool.query<{ venue_gallery_urls: unknown }>(
        `SELECT venue_gallery_urls FROM businesses WHERE id = $1 LIMIT 1`,
        [businessId],
      );
      return parseGalleryUrls(rows[0]?.venue_gallery_urls);
    } catch {
      return [];
    }
  }

  try {
    const { rows } = await pool.query<{ venue_gallery_urls: unknown }>(
      `SELECT venue_gallery_urls FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId],
    );
    const existing = parseGalleryUrls(rows[0]?.venue_gallery_urls);
    const merged = [...new Set([...existing, ...incoming])].slice(0, 24);
    await pool.query(
      `UPDATE businesses SET
         venue_gallery_urls = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [businessId, JSON.stringify(merged)],
    );
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/venue_gallery_urls/i.test(message)) {
      console.error("mergeBusinessGalleryUrls failed:", err);
    }
    return [];
  }
}

/**
 * Persist the business-chosen venue cover URL (user override; may replace prior).
 * Pass null/empty to clear. Returns the stored value (or null).
 */
export async function persistBusinessVenueCoverUrl(
  businessId: number,
  coverUrl: string | null | undefined,
): Promise<string | null> {
  if (!Number.isFinite(businessId) || businessId <= 0) return null;
  const clean =
    typeof coverUrl === "string" && coverUrl.trim() ? coverUrl.trim() : null;
  try {
    await pool.query(
      `UPDATE businesses SET
         venue_cover_url = $2,
         updated_at = NOW()
       WHERE id = $1`,
      [businessId, clean],
    );
    return clean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/venue_cover_url/i.test(message)) {
      console.error("persistBusinessVenueCoverUrl failed:", err);
    }
    return null;
  }
}
