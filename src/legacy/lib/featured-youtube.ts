/**
 * Featured campaign YouTube video URL helpers (additive).
 *
 * Purpose: Accept only watch / Shorts URLs for campaigns.featured_youtube_url.
 * Channel / @handle links are rejected (those belong on nonprofit.youtube_url).
 *
 * Inputs: raw user/body string.
 * Outputs: normalized https://www.youtube.com/watch?v=… or /shorts/… URL, or null.
 */
import { normalizeYouTubeUrl } from "./suggest-social-images";

/**
 * Normalize a featured YouTube video URL (watch or Shorts only).
 * Inputs: raw URL string (may be empty).
 * Outputs: stable watch/shorts https URL, or null when empty/invalid/not a video.
 */
export function normalizeFeaturedYouTubeVideoUrl(
  url: string | null | undefined,
): string | null {
  if (url == null) return null;
  const raw = String(url).trim();
  if (!raw) return null;

  const normalized = normalizeYouTubeUrl(raw);
  if (!normalized) return null;

  if (/youtube\.com\/watch\?v=[\w-]{6,}/i.test(normalized)) {
    return normalized;
  }
  if (/youtube\.com\/shorts\/[\w-]{6,}/i.test(normalized)) {
    return normalized;
  }
  return null;
}

export type FeaturedYoutubeBodyParse =
  | { ok: true; /** undefined = field omitted (caller keeps existing). */ value: string | null | undefined }
  | { ok: false; error: string };

/**
 * Parse optional featuredYoutubeUrl from a builder request body.
 * Inputs: body-like object that may include featuredYoutubeUrl.
 * Outputs: omit / null (clear) / normalized URL, or validation error.
 *
 * - Missing / undefined → omit (do not change existing DB value on PATCH)
 * - null or blank string → clear (NULL)
 * - non-empty invalid → error
 * - non-empty valid watch/shorts → normalized URL
 */
export function parseFeaturedYoutubeFromBody(body: {
  featuredYoutubeUrl?: string | null;
}): FeaturedYoutubeBodyParse {
  if (!Object.prototype.hasOwnProperty.call(body, "featuredYoutubeUrl")) {
    return { ok: true, value: undefined };
  }
  const raw = body.featuredYoutubeUrl;
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw === null || String(raw).trim() === "") {
    return { ok: true, value: null };
  }
  const normalized = normalizeFeaturedYouTubeVideoUrl(String(raw));
  if (!normalized) {
    return {
      ok: false,
      error:
        "Featured YouTube URL must be a valid YouTube watch or Shorts link",
    };
  }
  return { ok: true, value: normalized };
}
