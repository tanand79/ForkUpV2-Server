/**
 * Best-effort public social profile lookup when website scrape has no links
 * (or the org has no website).
 *
 * Purpose: Fill Facebook / Instagram / LinkedIn / YouTube URLs for Connect
 * without inventing unreachable pages.
 *
 * Inputs: organizationName (required), optional ein/city/state.
 * Outputs: normalized URLs that pass a lightweight HTTP check, or nulls.
 *
 * Additive helper — does not modify guess-nonprofit-website.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import {
  normalizeFacebookUrl,
  normalizeInstagramUrl,
  normalizeLinkedInUrl,
  normalizeYouTubeUrl,
} from "./suggest-social-images";

const VERIFY_TIMEOUT_MS = 6_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export type GuessedNonprofitSocial = {
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
  provider: string | null;
};

/**
 * Lightweight reachability check for a candidate social profile URL.
 * Inputs: absolute https URL. Outputs: true when GET succeeds (2xx/3xx follow).
 */
async function isReachablePublicUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the configured AI provider for likely public social profile URLs, then
 * verify each candidate before returning it.
 *
 * Inputs: org identity fields. Outputs: verified social URLs or null.
 */
export async function guessNonprofitSocialLinks(params: {
  organizationName: string;
  ein?: string | null;
  city?: string | null;
  state?: string | null;
}): Promise<GuessedNonprofitSocial> {
  const empty: GuessedNonprofitSocial = {
    facebookUrl: null,
    instagramUrl: null,
    linkedinUrl: null,
    youtubeUrl: null,
    provider: null,
  };

  const name = params.organizationName.trim();
  if (!name) return empty;

  if (aiProviderName() === "none") {
    return empty;
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
        "You find the organization's OWN official public social media profile URLs for a US nonprofit.",
        'Return ONLY JSON: {"facebookUrl": string, "instagramUrl": string, "linkedinUrl": string, "youtubeUrl": string}.',
        "Return only the nonprofit's original official pages — not local chapters, affiliates, donors, or lookalikes.",
        "Use full https URLs when confident they belong to this exact organization.",
        "Use empty string for any channel you are unsure about or that does not exist.",
        "Never invent handles or URLs. Never guess a URL pattern from the org name alone unless you know it is real.",
        "Prefer empty string over an assumed/wrong link.",
        "Instagram may be a profile URL or @handle; Facebook, LinkedIn, and YouTube must be https URLs.",
      ].join("\n"),
      user: contextParts.join("\n"),
      json: true,
      maxTokens: 360,
      temperature: 0.1,
    });

    let parsed: {
      facebookUrl?: unknown;
      instagramUrl?: unknown;
      linkedinUrl?: unknown;
      youtubeUrl?: unknown;
    } = {};
    try {
      parsed = parseAiJson(content) as typeof parsed;
    } catch {
      return empty;
    }

    const rawFb = typeof parsed.facebookUrl === "string" ? parsed.facebookUrl.trim() : "";
    const rawIg = typeof parsed.instagramUrl === "string" ? parsed.instagramUrl.trim() : "";
    const rawLi = typeof parsed.linkedinUrl === "string" ? parsed.linkedinUrl.trim() : "";
    const rawYt = typeof parsed.youtubeUrl === "string" ? parsed.youtubeUrl.trim() : "";

    const facebookCandidate = rawFb ? normalizeFacebookUrl(rawFb) : null;
    const instagramCandidate = rawIg ? normalizeInstagramUrl(rawIg) : null;
    const linkedinCandidate = rawLi ? normalizeLinkedInUrl(rawLi) : null;
    const youtubeCandidate = rawYt ? normalizeYouTubeUrl(rawYt) : null;

    const [fbOk, igOk, liOk, ytOk] = await Promise.all([
      facebookCandidate ? isReachablePublicUrl(facebookCandidate) : Promise.resolve(false),
      instagramCandidate ? isReachablePublicUrl(instagramCandidate) : Promise.resolve(false),
      linkedinCandidate ? isReachablePublicUrl(linkedinCandidate) : Promise.resolve(false),
      youtubeCandidate ? isReachablePublicUrl(youtubeCandidate) : Promise.resolve(false),
    ]);

    return {
      facebookUrl: fbOk ? facebookCandidate : null,
      instagramUrl: igOk ? instagramCandidate : null,
      linkedinUrl: liOk ? linkedinCandidate : null,
      youtubeUrl: ytOk ? youtubeCandidate : null,
      provider: aiProviderName(),
    };
  } catch {
    return empty;
  }
}
