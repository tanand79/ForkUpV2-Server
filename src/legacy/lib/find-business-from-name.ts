/**
 * Pass D1 — find a restaurant/local business profile from a public name.
 *
 * Purpose: Support mockup Step 1 “Find My Restaurant/Business” — AI suggests a
 * website from the name, then real HTML scrape fills location + photo checks.
 *
 * Inputs: businessName, optional joinDoorType (restaurant | local).
 * Outputs: confirmation payload (name, website, city/state/address, images, checks).
 *
 * Changelog (D1): Added — name → website (AI) + scrape + social/website images.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { looksLikeLogoUrl, suggestSocialImages } from "./suggest-social-images";
import {
  isEmptyLocationValue,
  scrapeBusinessLocationHints,
} from "./business-website-location";
import { normalizeJoinDoorType, type JoinDoorType } from "./join-door-type";

export type FindBusinessChecks = {
  websiteFound: boolean;
  logoFound: boolean;
  photosFound: boolean;
  locationFound: boolean;
};

export type FindBusinessFromNameResult = {
  businessName: string;
  website: string;
  businessType: string;
  about: string;
  contactEmail: string;
  phone: string;
  city: string;
  state: string;
  address: string;
  zip: string;
  locations: Array<{
    locationName: string;
    city: string;
    state: string;
    address?: string;
  }>;
  logoUrl: string | null;
  imageUrls: string[];
  checks: FindBusinessChecks;
  locationSourceUrl: string | null;
  joinDoorType: JoinDoorType | null;
  confirmationStatus: string;
  provider: string;
};

function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function suggestHostName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

/**
 * Resolve a reviewable business “we found you” card from a typed name.
 */
export async function findBusinessFromName(input: {
  businessName: string;
  joinDoorType?: unknown;
}): Promise<FindBusinessFromNameResult> {
  const businessName = input.businessName.trim();
  if (!businessName || businessName.length > 200) {
    throw new Error("Business name is required.");
  }
  const joinDoorType = normalizeJoinDoorType(input.joinDoorType);
  const doorLabel = joinDoorType === "local" ? "local business" : "restaurant";

  let website = "";
  let about = "";
  let contactEmail = "";
  let phone = "";
  let city = "";
  let state = "";
  let businessType = joinDoorType === "local" ? "Local Business" : "Restaurant";

  if (aiProviderName() !== "none") {
    const system = [
      `You help ForkUp find a public ${doorLabel} website from a business name.`,
      "Return ONLY JSON with keys: website, businessName, businessType, about, contactEmail, phone, city, state.",
      "website must be the official public homepage URL when reasonably known; otherwise guess the most likely official site.",
      "Never invent private emails or phones. Leave unknown fields as empty strings.",
      "Do not use placeholder phrases like 'Not provided on the website'.",
    ].join("\n");
    const content = await aiChat({
      system,
      user: `${doorLabel} name: ${businessName}`,
      json: true,
      maxTokens: 1024,
      temperature: 0.1,
    });
    try {
      const parsed = parseAiJson(content);
      const str = (k: string) => {
        const v = parsed[k];
        return typeof v === "string" ? v.trim() : "";
      };
      website = normalizeWebsite(str("website"));
      about = str("about");
      contactEmail = str("contactEmail");
      phone = str("phone");
      city = isEmptyLocationValue(str("city")) ? "" : str("city");
      state = isEmptyLocationValue(str("state")) ? "" : str("state");
      businessType = str("businessType") || businessType;
    } catch {
      /* scrape may still help if we can guess a host */
    }
  }

  if (!website) {
    const hostGuess = suggestHostName(businessName);
    if (hostGuess) website = `https://www.${hostGuess}.com`;
  }

  const hints = website
    ? await scrapeBusinessLocationHints(website)
    : {
        address: "",
        city: "",
        state: "",
        zip: "",
        pageText: "",
        sourceUrl: null,
        websiteFound: false,
      };

  if (isEmptyLocationValue(city) && hints.city) city = hints.city;
  if (isEmptyLocationValue(state) && hints.state) state = hints.state;
  const address = hints.address;
  const zip = hints.zip;

  const imageSuggestions = website
    ? await suggestSocialImages({ websiteUrl: website, limit: 6 })
    : [];
  const imageUrls = imageSuggestions.map((img) => img.url).filter(Boolean);
  const logoCandidate =
    imageUrls.find((u) => looksLikeLogoUrl(u)) ?? imageUrls[0] ?? null;
  const photoUrls = imageUrls.filter((u) => !looksLikeLogoUrl(u));

  const locationFound = Boolean(city || state || address);
  const checks: FindBusinessChecks = {
    websiteFound: hints.websiteFound || Boolean(website),
    logoFound: Boolean(logoCandidate),
    photosFound: photoUrls.length > 0 || imageUrls.length > 0,
    locationFound,
  };

  const locations =
    locationFound || businessName
      ? [
          {
            locationName: city ? `${businessName} — ${city}` : businessName,
            city,
            state,
            ...(address ? { address } : {}),
          },
        ]
      : [];

  return {
    businessName,
    website,
    businessType,
    about,
    contactEmail,
    phone,
    city,
    state,
    address,
    zip,
    locations,
    logoUrl: logoCandidate,
    imageUrls,
    checks,
    locationSourceUrl: hints.sourceUrl,
    joinDoorType,
    confirmationStatus: "Find Draft",
    provider: aiProviderName() === "none" ? "website_scrape" : aiProviderName(),
  };
}
