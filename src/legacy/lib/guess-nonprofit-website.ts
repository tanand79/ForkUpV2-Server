import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { findKnownOrganizationByName } from "./known-organization-profiles";

/**
 * Best-effort official website lookup when IRS/Every.org enrichment has no URL.
 *
 * Inputs: organizationName (required), optional ein/city/state for disambiguation.
 * Output: normalized https URL string, or null when unknown / AI unavailable.
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
    return { website: normalizeWebsite(known.website), provider: "known_profile" };
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
        "Put the organization's OWN official website when you are confident it belongs to this exact organization.",
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

    return { website: normalizeWebsite(raw), provider: aiProviderName() };
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
