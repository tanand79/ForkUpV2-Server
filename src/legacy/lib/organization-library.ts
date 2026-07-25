import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";

export type LibraryOrgType = "nonprofit" | "business";

export type ApprovedLibraryItem = {
  category: string;
  title: string | null;
  content: string | null;
  sourceUrl: string | null;
  assetUrl: string | null;
};

/**
 * Loads approved (review_status = 'approved') library items for an organization.
 * Used to feed the entity-specific AI layer (campaign drafts) and Success Engine
 * content. Returns an empty array on any error so callers never break.
 */
export async function fetchApprovedLibraryItems(
  orgType: LibraryOrgType,
  orgId: number,
): Promise<ApprovedLibraryItem[]> {
  if (!orgId) return [];
  try {
    const { rows } = await pool.query<QueryResultRow>(
      `SELECT category, title, content, source_url, asset_url
       FROM organization_library_items
       WHERE organization_type = $1
         AND organization_id = $2
         AND review_status = 'approved'
       ORDER BY category ASC, id DESC`,
      [orgType, orgId],
    );
    return rows.map((r) => ({
      category: String(r.category),
      title: r.title ? String(r.title) : null,
      content: r.content ? String(r.content) : null,
      sourceUrl: r.source_url ? String(r.source_url) : null,
      assetUrl: r.asset_url ? String(r.asset_url) : null,
    }));
  } catch (err) {
    console.error("[organization-library] Failed to load approved items:", err);
    return [];
  }
}

const CONTENT_CATEGORIES = new Set([
  "stories_testimonials",
  "results_impact",
  "reusable_content",
  "past_events",
]);

/**
 * Builds a plain-text context block from approved library items, suitable for
 * appending to an AI prompt. Returns "" when there is nothing useful.
 */
export function buildLibraryContext(items: ApprovedLibraryItem[]): string {
  const useful = items.filter(
    (i) => CONTENT_CATEGORIES.has(i.category) && (i.title || i.content),
  );
  if (useful.length === 0) return "";
  const lines = useful.slice(0, 12).map((i) => {
    const label = i.title ? `${i.title}: ` : "";
    return `- (${i.category}) ${label}${i.content ?? ""}`.trim();
  });
  return `Approved organization library content (use for authentic voice; do not invent beyond this):\n${lines.join("\n")}`;
}

/**
 * Picks a short approved snippet (reusable content or a story) to enrich the
 * Success Engine launch message. Returns null when nothing suitable exists.
 */
export function pickLaunchSnippet(items: ApprovedLibraryItem[]): string | null {
  const preferred =
    items.find((i) => i.category === "reusable_content" && i.content) ??
    items.find((i) => i.category === "stories_testimonials" && i.content) ??
    items.find((i) => i.category === "results_impact" && i.content);
  const text = preferred?.content?.trim();
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/**
 * Picks a short approved snippet focused on outcomes (results/impact, then past
 * events, then a story) to enrich reminder / results Success Engine messages.
 * Returns null when nothing suitable exists.
 */
export function pickImpactSnippet(items: ApprovedLibraryItem[]): string | null {
  const preferred =
    items.find((i) => i.category === "results_impact" && i.content) ??
    items.find((i) => i.category === "past_events" && i.content) ??
    items.find((i) => i.category === "stories_testimonials" && i.content);
  const text = preferred?.content?.trim();
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/**
 * Picks an approved image URL to suggest as a campaign cover/featured image.
 * Prefers real photos over brand logos. Returns null when no approved image
 * asset exists.
 */
export function pickFeaturedImage(items: ApprovedLibraryItem[]): string | null {
  const preferred =
    items.find((i) => i.category === "photos_images" && i.assetUrl) ??
    items.find((i) => i.category === "logos_brand" && i.assetUrl);
  return preferred?.assetUrl?.trim() || null;
}
