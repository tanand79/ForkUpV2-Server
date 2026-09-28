/**
 * Hydrate nonprofit org profile from AI session + public discovery.
 *
 * Purpose: View-profile shows website/social/location the Create Campaign AI
 * finds. Gallery photos are refreshed client-side (Instagram CDN hotlinks expire).
 *
 * Strategy:
 *   1) Latest completed organization_ai_analysis_sessions for this nonprofit
 *   2) If still missing website/social/city → resolveAnalysisSources
 *   3) Null-only persist onto nonprofits (never overwrite user edits)
 *
 * Inputs: nonprofitId. Outputs: hydrated profile fields for the API response.
 */
import { pool } from "../db/pool";
import {
  extractOrgPageMeta,
  resolveAnalysisSources,
} from "./organization-ai-campaign-flow";
import {
  fillNonprofitPublicProfileNullOnly,
  parseNonprofitGalleryUrls,
} from "./persist-nonprofit-public-links";

export type NonprofitOrgProfilePayload = {
  nonprofitId: number;
  organizationName: string;
  slug: string;
  about: string;
  mission: string | null;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  phone: string | null;
  causeCategory: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  logoUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  galleryImageUrls: string[];
  coverUrl: string | null;
};

type NonprofitRow = {
  id: number;
  organization_name: string;
  slug: string;
  mission: string | null;
  description: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  cause_category: string | null;
  ein: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  logo_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
  tiktok_url: string | null;
  youtube_url: string | null;
  gallery_urls: unknown;
  cover_url: string | null;
};

type AiSessionAnalysis = {
  website?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  youtubeUrl?: string | null;
  city?: string | null;
  state?: string | null;
  mission?: string | null;
  images?: Array<{ url?: string | null }>;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function rowToPayload(row: NonprofitRow): NonprofitOrgProfilePayload {
  const galleryImageUrls = parseNonprofitGalleryUrls(row.gallery_urls);
  return {
    nonprofitId: row.id,
    organizationName: row.organization_name,
    slug: row.slug,
    about: row.description?.trim() || row.mission?.trim() || "",
    mission: row.mission,
    website: trimOrNull(row.website),
    contactName: row.contact_name,
    contactEmail: trimOrNull(row.contact_email),
    phone: trimOrNull(row.contact_phone),
    causeCategory: row.cause_category,
    city: trimOrNull(row.city),
    state: trimOrNull(row.state),
    zip: trimOrNull(row.zip),
    logoUrl: trimOrNull(row.logo_url),
    facebookUrl: trimOrNull(row.facebook_url),
    instagramUrl: trimOrNull(row.instagram_url),
    linkedinUrl: trimOrNull(row.linkedin_url),
    tiktokUrl: trimOrNull(row.tiktok_url),
    youtubeUrl: trimOrNull(row.youtube_url),
    galleryImageUrls,
    coverUrl: trimOrNull(row.cover_url),
  };
}

function needsHydrate(payload: NonprofitOrgProfilePayload): boolean {
  const hasSocial = Boolean(
    payload.facebookUrl ||
      payload.instagramUrl ||
      payload.linkedinUrl ||
      payload.youtubeUrl ||
      payload.tiktokUrl ||
      payload.website,
  );
  const hasLocation = Boolean(payload.city || payload.state);
  return !hasSocial || !hasLocation;
}

async function loadLatestAiAnalysis(
  nonprofitId: number,
  organizationName: string,
): Promise<AiSessionAnalysis | null> {
  try {
    const { rows } = await pool.query<{
      website: string | null;
      facebook_url: string | null;
      instagram_url: string | null;
      linkedin_url: string | null;
      analysis_json: unknown;
    }>(
      `SELECT website, facebook_url, instagram_url, linkedin_url, analysis_json
         FROM organization_ai_analysis_sessions
        WHERE status = 'completed'
          AND analysis_json IS NOT NULL
          AND (
            nonprofit_id = $1
            OR (
              nonprofit_id IS NULL
              AND LOWER(TRIM(organization_name)) = LOWER(TRIM($2))
            )
          )
        ORDER BY
          CASE WHEN nonprofit_id = $1 THEN 0 ELSE 1 END,
          id DESC
        LIMIT 1`,
      [nonprofitId, organizationName],
    );
    const row = rows[0];
    if (!row) return null;

    const analysis =
      row.analysis_json && typeof row.analysis_json === "object"
        ? (row.analysis_json as AiSessionAnalysis)
        : null;

    return {
      website: analysis?.website || row.website,
      facebookUrl: analysis?.facebookUrl || row.facebook_url,
      instagramUrl: analysis?.instagramUrl || row.instagram_url,
      linkedinUrl: analysis?.linkedinUrl || row.linkedin_url,
      youtubeUrl: analysis?.youtubeUrl || null,
      city: analysis?.city || null,
      state: analysis?.state || null,
      mission: analysis?.mission || null,
      images: Array.isArray(analysis?.images) ? analysis!.images : [],
    };
  } catch {
    return null;
  }
}

async function reloadNonprofit(
  nonprofitId: number,
): Promise<NonprofitRow | null> {
  const { rows } = await pool.query<NonprofitRow>(
    `SELECT id, organization_name, slug, mission, description, website,
            contact_name, contact_email, contact_phone, cause_category, ein,
            city, state, zip, logo_url,
            facebook_url, instagram_url, linkedin_url, tiktok_url, youtube_url,
            gallery_urls, cover_url
       FROM nonprofits WHERE id = $1 LIMIT 1`,
    [nonprofitId],
  );
  return rows[0] ?? null;
}

/**
 * Load org profile; fill missing website/social/location from AI session +
 * live discovery. Gallery photos are refreshed in the web app via
 * suggestCampaignImages (CDN signed URLs expire and cannot be stored long-term).
 */
export async function loadAndHydrateNonprofitOrgProfile(
  nonprofitId: number,
): Promise<NonprofitOrgProfilePayload | null> {
  const initial = await reloadNonprofit(nonprofitId);
  if (!initial) return null;

  let payload = rowToPayload(initial);
  if (!needsHydrate(payload)) return payload;

  const ai = await loadLatestAiAnalysis(
    nonprofitId,
    payload.organizationName,
  );

  if (ai) {
    await fillNonprofitPublicProfileNullOnly(nonprofitId, {
      website: ai.website,
      facebookUrl: ai.facebookUrl,
      instagramUrl: ai.instagramUrl,
      linkedinUrl: ai.linkedinUrl,
      youtubeUrl: ai.youtubeUrl,
      city: ai.city,
      state: ai.state,
      about: ai.mission,
      mission: ai.mission,
    });
    const afterAi = await reloadNonprofit(nonprofitId);
    if (afterAi) payload = rowToPayload(afterAi);
    if (!needsHydrate(payload)) return payload;
  }

  try {
    const sources = await resolveAnalysisSources({
      organizationName: payload.organizationName,
      nonprofitId,
      website: payload.website,
      facebookUrl: payload.facebookUrl,
      instagramUrl: payload.instagramUrl,
      linkedinUrl: payload.linkedinUrl,
      youtubeUrl: payload.youtubeUrl,
      mission: payload.mission,
      causeCategory: payload.causeCategory,
      city: payload.city,
      state: payload.state,
      ein: initial.ein,
    });

    const pageMeta = sources.website
      ? await extractOrgPageMeta(sources.website)
      : null;

    const about =
      sources.mission || pageMeta?.description || payload.about || null;

    await fillNonprofitPublicProfileNullOnly(nonprofitId, {
      website: sources.website,
      facebookUrl: sources.facebookUrl,
      instagramUrl: sources.instagramUrl,
      linkedinUrl: sources.linkedinUrl,
      youtubeUrl: sources.youtubeUrl,
      city: sources.city,
      state: sources.state,
      about,
      mission: sources.mission || about,
    });
  } catch (err) {
    console.error("nonprofit org profile live hydrate failed:", err);
  }

  const finalRow = await reloadNonprofit(nonprofitId);
  return finalRow ? rowToPayload(finalRow) : payload;
}
