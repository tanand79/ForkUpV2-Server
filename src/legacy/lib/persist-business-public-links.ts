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
import { ensureDurableVenueGalleryUrls } from "./ensure-durable-image";

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
  /** Maps to businesses.description (About). */
  description?: string | null;
  /** Giveback weekday labels — maps to venue_discount_hours JSONB. */
  discountHours?: Record<string, string> | null;
  /** Free-text eligible window — maps to venue_eligible_window. */
  eligibleWindow?: string | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

export const VENUE_DISCOUNT_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type VenueDiscountHoursMap = Record<
  (typeof VENUE_DISCOUNT_DAYS)[number],
  string
>;

/** Closed/unknown day markers for durable giveback hours. */
export function defaultVenueDiscountHours(): VenueDiscountHoursMap {
  return {
    Monday: "-",
    Tuesday: "-",
    Wednesday: "-",
    Thursday: "-",
    Friday: "-",
    Saturday: "-",
    Sunday: "-",
  };
}

/** Normalize unknown JSON / object into weekday → label map. */
export function normalizeVenueDiscountHours(
  value: unknown,
): VenueDiscountHoursMap {
  const hours = defaultVenueDiscountHours();
  if (!value || typeof value !== "object") return hours;
  for (const day of VENUE_DISCOUNT_DAYS) {
    const raw = (value as Record<string, unknown>)[day];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    hours[day] = trimmed || "-";
  }
  return hours;
}

export function venueDiscountHoursHaveOpenDay(
  hours: VenueDiscountHoursMap,
): boolean {
  return VENUE_DISCOUNT_DAYS.some((day) => {
    const v = hours[day]?.trim() ?? "";
    return Boolean(v) && v !== "-" && v !== "—";
  });
}

/**
 * Null-only fill for giveback hours / eligible window.
 * When `markResolved` is true and hours are empty, stores all "-" so hydrate
 * knows AI already ran (avoids re-scrape every open).
 */
export async function persistVenueDiscountHours(
  businessId: number,
  hours: Record<string, string> | null | undefined,
  eligibleWindow?: string | null,
  options?: { overwrite?: boolean; markResolved?: boolean },
): Promise<void> {
  if (!Number.isFinite(businessId) || businessId <= 0) return;
  const overwrite = options?.overwrite === true;
  const markResolved = options?.markResolved !== false;
  const normalized = normalizeVenueDiscountHours(hours ?? null);
  const hasOpen = venueDiscountHoursHaveOpenDay(normalized);
  if (!hasOpen && !markResolved && !overwrite) return;

  const payload = JSON.stringify(normalized);
  const windowVal = trimOrNull(eligibleWindow);

  try {
    if (overwrite) {
      await pool.query(
        `UPDATE businesses SET
           venue_discount_hours = $2::jsonb,
           venue_eligible_window = COALESCE($3, venue_eligible_window),
           updated_at = NOW()
         WHERE id = $1`,
        [businessId, payload, windowVal],
      );
      return;
    }
    await pool.query(
      `UPDATE businesses SET
         venue_discount_hours = COALESCE(venue_discount_hours, $2::jsonb),
         venue_eligible_window = COALESCE(NULLIF(TRIM(venue_eligible_window), ''), $3),
         updated_at = NOW()
       WHERE id = $1`,
      [businessId, payload, windowVal],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/venue_discount_hours|venue_eligible_window/i.test(message)) {
      console.error("persistVenueDiscountHours failed:", err);
    }
  }
}

/**
 * Null-only fill for primary business_locations address fields.
 */
export async function persistPrimaryBusinessLocationDetails(
  businessId: number,
  loc: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
  },
): Promise<void> {
  if (!Number.isFinite(businessId) || businessId <= 0) return;
  const address = trimOrNull(loc.address);
  const city = trimOrNull(loc.city);
  const state = trimOrNull(loc.state);
  const zip = trimOrNull(loc.zip);
  const phone = trimOrNull(loc.phone);
  if (!address && !city && !state && !zip && !phone) return;

  try {
    await pool.query(
      `UPDATE business_locations SET
         address = COALESCE(NULLIF(TRIM(address), ''), $2),
         city = COALESCE(NULLIF(TRIM(city), ''), $3),
         state = COALESCE(NULLIF(TRIM(state), ''), $4),
         zip = COALESCE(NULLIF(TRIM(zip), ''), $5),
         phone = COALESCE(NULLIF(TRIM(phone), ''), $6),
         updated_at = NOW()
       WHERE id = (
         SELECT id FROM business_locations
         WHERE business_id = $1 AND active_status = TRUE
         ORDER BY id ASC
         LIMIT 1
       )`,
      [businessId, address, city, state, zip, phone],
    );
  } catch (err) {
    console.error("persistPrimaryBusinessLocationDetails failed:", err);
  }
}

/**
 * Owner edit — overwrite primary location fields that are present on `loc`.
 */
export async function updatePrimaryBusinessLocationDetails(
  businessId: number,
  loc: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
  },
): Promise<void> {
  if (!Number.isFinite(businessId) || businessId <= 0) return;
  const sets: string[] = [];
  const params: (string | number | null)[] = [businessId];
  const push = (column: string, value: string | null | undefined, present: boolean) => {
    if (!present) return;
    params.push(trimOrNull(value));
    sets.push(`${column} = $${params.length}`);
  };
  push("address", loc.address, Object.prototype.hasOwnProperty.call(loc, "address"));
  push("city", loc.city, Object.prototype.hasOwnProperty.call(loc, "city"));
  push("state", loc.state, Object.prototype.hasOwnProperty.call(loc, "state"));
  push("zip", loc.zip, Object.prototype.hasOwnProperty.call(loc, "zip"));
  push("phone", loc.phone, Object.prototype.hasOwnProperty.call(loc, "phone"));
  if (sets.length === 0) return;
  try {
    await pool.query(
      `UPDATE business_locations SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = (
         SELECT id FROM business_locations
         WHERE business_id = $1 AND active_status = TRUE
         ORDER BY id ASC
         LIMIT 1
       )`,
      params,
    );
  } catch (err) {
    console.error("updatePrimaryBusinessLocationDetails failed:", err);
  }
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
  const description = trimOrNull(links.description);
  const hasHoursInput =
    links.discountHours != null ||
    Object.prototype.hasOwnProperty.call(links, "eligibleWindow");

  if (
    !website &&
    !facebookUrl &&
    !instagramUrl &&
    !linkedinUrl &&
    !tiktokUrl &&
    !phone &&
    !venueEmail &&
    !description &&
    !hasHoursInput
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
         description = COALESCE(NULLIF(TRIM(description), ''), $9),
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
        description,
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
           description = COALESCE(NULLIF(TRIM(description), ''), $8),
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
          description,
        ],
      );
    } catch (err2) {
      console.error("persistBusinessPublicLinks fallback failed:", err2);
    }
  }

  if (hasHoursInput) {
    await persistVenueDiscountHours(
      businessId,
      links.discountHours ?? null,
      links.eligibleWindow,
      { markResolved: true },
    );
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
  /** About copy → businesses.description */
  description?: string | null;
  discountHours?: Record<string, string> | null;
  eligibleWindow?: string | null;
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

  type StringLinkKey = Exclude<
    keyof BusinessPublicLinksUpdate,
    "discountHours"
  >;

  const push = (
    column: string,
    key: StringLinkKey,
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
  push(
    "description",
    "description",
    links.description,
    Object.prototype.hasOwnProperty.call(links, "description"),
  );

  const hasHours = Object.prototype.hasOwnProperty.call(links, "discountHours");
  const hasWindow = Object.prototype.hasOwnProperty.call(links, "eligibleWindow");
  if (hasHours) {
    const normalized = normalizeVenueDiscountHours(links.discountHours ?? null);
    params.push(JSON.stringify(normalized));
    sets.push(`venue_discount_hours = $${params.length}::jsonb`);
    written.discountHours = normalized;
  }
  if (hasWindow) {
    const windowVal = trimOrNull(links.eligibleWindow);
    params.push(windowVal);
    sets.push(`venue_eligible_window = $${params.length}`);
    written.eligibleWindow = windowVal;
  }

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
    if (
      /venue_discount_hours|venue_eligible_window/i.test(message) &&
      (hasHours || hasWindow)
    ) {
      const {
        discountHours: _h,
        eligibleWindow: _w,
        ...rest
      } = links;
      return updateBusinessPublicLinks(businessId, rest);
    }
    console.error("updateBusinessPublicLinks failed:", err);
    return null;
  }
}

/**
 * Persist venue gallery photo URLs (null/empty only — never wipe a richer set).
 * Re-hosts remote/CDN URLs into ForkUp storage before write.
 * Inputs: businessId, absolute image URL list.
 * Outputs: durable URL list prepared for storage (even if DB keep-existing skipped write).
 */
export async function persistBusinessGalleryUrls(
  businessId: number,
  urls: string[],
): Promise<string[]> {
  if (!Number.isFinite(businessId) || businessId <= 0) return [];
  const durable = await ensureDurableVenueGalleryUrls(urls);
  const clean = [...new Set(durable.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    24,
  );
  if (clean.length === 0) return [];
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
  return clean;
}

/**
 * Replace venue gallery entirely (Edit → Re-scrape). Fixes broken cached URLs.
 * Re-hosts remote/CDN URLs into ForkUp storage before write.
 * Inputs: businessId, absolute image URL list (may be empty to clear).
 * Outputs: durable URL list actually stored (empty on skip/failure).
 */
export async function replaceBusinessGalleryUrls(
  businessId: number,
  urls: string[],
): Promise<string[]> {
  if (!Number.isFinite(businessId) || businessId <= 0) return [];
  const durable = await ensureDurableVenueGalleryUrls(urls);
  const clean = [...new Set(durable.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    24,
  );
  try {
    await pool.query(
      `UPDATE businesses SET
         venue_gallery_urls = $2::jsonb,
         venue_cover_url = COALESCE($3, venue_cover_url),
         updated_at = NOW()
       WHERE id = $1`,
      [businessId, JSON.stringify(clean), clean[0] ?? null],
    );
    return clean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/venue_cover_url/i.test(message)) {
      try {
        await pool.query(
          `UPDATE businesses SET
             venue_gallery_urls = $2::jsonb,
             updated_at = NOW()
           WHERE id = $1`,
          [businessId, JSON.stringify(clean)],
        );
        return clean;
      } catch (err2) {
        console.error("replaceBusinessGalleryUrls fallback failed:", err2);
        return clean;
      }
    }
    if (!/venue_gallery_urls/i.test(message)) {
      console.error("replaceBusinessGalleryUrls failed:", err);
    }
    return clean;
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
    const durableIncoming = await ensureDurableVenueGalleryUrls(incoming);
    const merged = [...new Set([...existing, ...durableIncoming])].slice(0, 24);
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
