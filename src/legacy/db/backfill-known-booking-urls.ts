/**
 * Fill empty reservation_url for Sovana Bistro and The Pear.
 *
 * Purpose: Those two restaurants book on Resy. The public campaign card
 * only shows a booking link when business_locations.reservation_url is set.
 * Does not overwrite a URL that is already stored.
 *
 * Inputs: none (uses pool). Outputs: rows updated.
 */
import { isDirectRun, type DbTaskOptions } from "./cli";
import { pool } from "./pool";

const KNOWN_BOOKING_URLS: { name: string; slug: string; url: string }[] = [
  {
    name: "sovana bistro",
    slug: "sovana-bistro",
    url: "https://resy.com/cities/kennett-square-pa/venues/sovana-bistro",
  },
  {
    name: "the pear",
    slug: "the-pear",
    url: "https://resy.com/cities/west-chester-pa/venues/the-pear",
  },
];

export async function backfillKnownBookingUrls(options: DbTaskOptions = {}) {
  for (const row of KNOWN_BOOKING_URLS) {
    const { rows } = await pool.query<{
      business_name: string;
      location_name: string;
      reservation_url: string;
    }>(
      `UPDATE business_locations bl
       SET reservation_url = $1, updated_at = NOW()
       FROM businesses b
       WHERE bl.business_id = b.id
         AND (bl.reservation_url IS NULL OR btrim(bl.reservation_url) = '')
         AND (
           lower(b.business_name) = $2
           OR lower(b.business_name) LIKE $2 || ' %'
           OR lower(b.business_name) LIKE $2 || '-%'
           OR lower(b.slug) = $3
           OR lower(b.slug) LIKE $3 || '-%'
         )
       RETURNING b.business_name, bl.location_name, bl.reservation_url`,
      [row.url, row.name, row.slug],
    );
    if (rows.length === 0) {
      console.log(`No empty location updated for "${row.name}".`);
    } else {
      for (const updated of rows) {
        console.log(
          `Set booking link for ${updated.business_name} / ${updated.location_name}: ${updated.reservation_url}`,
        );
      }
    }
  }

  if (options.closePool !== false) {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  backfillKnownBookingUrls().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
