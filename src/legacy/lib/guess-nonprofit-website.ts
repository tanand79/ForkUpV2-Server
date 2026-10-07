import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { findKnownOrganizationByName } from "./known-organization-profiles";
import {
  discoverNonprofitWebsite,
  nonprofitWebResearchConfigured,
} from "./nonprofit-web-research";
import { verifyWebsiteBelongsToOrg } from "./verify-nonprofit-identity";

/**
 * Best-effort official website lookup when IRS/Every.org enrichment has no URL.
 *
 * Order:
 * 1) Known profile registry
 * 2) Tavily + Bedrock evidence search (when TAVILY_API_KEY configured)
 * 3) AI memory guess (Bedrock/Lovable) — legacy fallback
 * Then live page identity verify before returning a URL.
 *
 * Inputs: organizationName (required), optional ein/city/state for disambiguation.
 * Output: normalized https URL string, or null when unknown / AI unavailable /
 *         page does not verify as belonging to this exact organization.
 */
export async function guessNonprofitWebsite(params: {
  organizationName: string;
  ein?: string | null;
  city?: string | null;
  state?: string | null;
}): Promise<{ website: string | null; provider: string | null }> {
  const name = params.organizationName.trim();
  if (!name) return { website: null, provider: null };

  const known = findKnownOrganizationByName(name);
  if (known?.website?.trim()) {
    const verified = await verifyWebsiteBelongsToOrg({
      organizationName: name,
      website: known.website,
      city: params.city,
      state: params.state,
    });
    if (verified.ok && verified.website) {
      return { website: verified.website, provider: "known_profile" };
    }
    // Known registry miss on live verify — fall through to AI rather than return wrong site.
  }

  // Live web evidence (forkupnpo research) before LLM memory guess.
  if (nonprofitWebResearchConfigured()) {
    const discovered = await discoverNonprofitWebsite({
      organizationName: name,
      ein: params.ein,
      city: params.city,
      state: params.state,
    });
    if (discovered.status === "found" && discovered.website) {
      const verified = await verifyWebsiteBelongsToOrg({
        organizationName: discovered.name || name,
        website: discovered.website,
        city: params.city,
        state: params.state,
      });
      if (verified.ok && verified.website) {
        return { website: verified.website, provider: "tavily_bedrock" };
      }
      // Evidence URL failed page verify — still prefer it over inventing another domain
      // only when verify was unreachable (timeout), not identity reject.
      if (verified.reason === "unreachable") {
        const normalized = normalizeWebsite(discovered.website);
        if (normalized) {
          return { website: normalized, provider: "tavily_bedrock" };
        }
      }
    }
  }

  if (aiProviderName() === "none") {
    return { website: null, provider: null };
  }

  const contextParts = [`Organization name: ${name}`];
  if (params.ein?.trim()) contextParts.push(`EIN: ${params.ein.trim()}`);
  if (params.city?.trim() || params.state?.trim()) {
    contextParts.push(
      `Location: ${[params.city?.trim(), params.state?.trim()].filter(Boolean).join(", ")}`,
    );
  }

  try {
    const content = await aiChat({
      system: [
        "You find the official public website URL for a US nonprofit organization.",
        "Return ONLY JSON: {\"website\": string}.",
        "Put the organization's OWN official website when you are confident it belongs to this EXACT organization name.",
        "Do NOT return a similar-sounding organization (example: searching \"Head To Head\" must NOT return Headstrong or headstrong.org).",
        "Do not return affiliate, directory, Facebook, Instagram, GuideStar, Charity Navigator, or donation-processor pages when a real website exists.",
        "Use https:// when returning a URL.",
        "If unsure, or no public website exists, return {\"website\": \"\"}. Prefer empty over an assumed domain.",
        "Never invent domains.",
      ].join("\n"),
      user: contextParts.join("\n"),
      json: true,
      maxTokens: 256,
      temperature: 0.1,
    });

    let parsed: { website?: unknown } = {};
    try {
      parsed = parseAiJson(content) as { website?: unknown };
    } catch {
      return { website: null, provider: null };
    }

    const raw = typeof parsed.website === "string" ? parsed.website.trim() : "";
    if (!raw) return { website: null, provider: null };

    const normalized = normalizeWebsite(raw);
    if (!normalized) return { website: null, provider: null };

    const verified = await verifyWebsiteBelongsToOrg({
      organizationName: name,
      website: normalized,
      city: params.city,
      state: params.state,
    });
    if (!verified.ok || !verified.website) {
      return { website: null, provider: null };
    }

    return { website: verified.website, provider: aiProviderName() };
  } catch {
    return { website: null, provider: null };
  }
}

function normalizeWebsite(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9][-a-z0-9.]*\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return null;
}
