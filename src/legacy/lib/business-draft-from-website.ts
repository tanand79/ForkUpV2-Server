/**
 * AI business profile draft from a public website URL.
 *
 * Inputs: website URL string.
 * Outputs: business fields, optional locations[], image URLs from public scrape.
 *
 * Changelog (D1): Prefer scraped Hours/Location page text + US address parse
 * over AI-only city/state guesses; strip "Not provided" placeholders.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { suggestSocialImages } from "./suggest-social-images";
import {
  isEmptyLocationValue,
  scrapeBusinessLocationHints,
} from "./business-website-location";

export type BusinessLocationDraft = {
  locationName: string;
  city: string;
  state: string;
  address?: string;
};

export type BusinessDraftFromWebsite = {
  website: string;
  businessName: string;
  businessType: string;
  about: string;
  contactEmail: string;
  phone: string;
  city: string;
  state: string;
  locations: BusinessLocationDraft[];
  imageUrls: string[];
  supportsDineAndDonate: boolean;
  supportsShopAndDonate: boolean;
  supportsServiceGiveback: boolean;
  supportsGuestBartending: boolean;
  missingFields: string[];
  confirmationStatus: "AI Draft" | string;
  provider: string;
};

function normalizeWebsiteInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function suggestNameFromHost(website: string): string {
  try {
    const host = new URL(normalizeWebsiteInput(website)).hostname.replace(/^www\./, "");
    const base = host.split(".")[0] ?? "";
    if (!base) return "";
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return "";
  }
}

/**
 * Build a reviewable business onboarding draft from website URL.
 */
export async function generateBusinessDraftFromWebsite(
  websiteInput: string,
): Promise<BusinessDraftFromWebsite> {
  const website = normalizeWebsiteInput(websiteInput);
  if (!website || website.length > 2048) {
    throw new Error("A valid website URL is required.");
  }

  const imageSuggestions = await suggestSocialImages({ websiteUrl: website, limit: 6 });
  const imageUrls = imageSuggestions.map((img) => img.url).filter(Boolean);

  const fallbackName = suggestNameFromHost(website);
  const locationHints = await scrapeBusinessLocationHints(website);

  if (aiProviderName() === "none") {
    const city = locationHints.city;
    const state = locationHints.state;
    return {
      website,
      businessName: fallbackName,
      businessType: "Restaurant",
      about: "",
      contactEmail: "",
      phone: "",
      city,
      state,
      locations: fallbackName
        ? [
            {
              locationName: "Main Location",
              city,
              state,
              ...(locationHints.address ? { address: locationHints.address } : {}),
            },
          ]
        : [],
      imageUrls,
      supportsDineAndDonate: true,
      supportsShopAndDonate: false,
      supportsServiceGiveback: false,
      supportsGuestBartending: false,
      missingFields: [
        "Business name",
        "Contact email",
        ...(city || state ? [] : ["City / state"]),
      ],
      confirmationStatus: "Website only",
      provider: "website_scrape",
    };
  }

  const system = [
    "You draft ForkUp business partner profiles from a restaurant or local business website.",
    "Return a DRAFT for human review — never invent private contact emails or phone numbers.",
    "Prefer city, state, and address from PAGE TEXT when present — do not invent placeholders like 'Not provided on the website'.",
    "If multiple locations are mentioned, include each in locations[].",
    "Infer fundraising capabilities: restaurants usually support dine_and_donate; retail supports shop_and_donate.",
    "Return ONLY JSON with keys:",
    "businessName, businessType, about, contactEmail, phone, city, state,",
    "locations (array of { locationName, city, state, address }),",
    "supportsDineAndDonate, supportsShopAndDonate, supportsServiceGiveback, supportsGuestBartending (booleans).",
  ].join("\n");

  const pageBlock = locationHints.pageText
    ? `\n\nPAGE TEXT (may include Hours & Location / Contact):\n${locationHints.pageText}`
    : "\n\nPAGE TEXT: (unavailable)";

  const content = await aiChat({
    system,
    user: `Business website: ${website}${pageBlock}`,
    json: true,
    maxTokens: 2048,
    temperature: 0.2,
  });

  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseAiJson(content);
  } catch {
    parsed = {};
  }

  const str = (key: string) => {
    const v = parsed[key];
    return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  };
  const bool = (key: string, fallback = false) => {
    const v = parsed[key];
    return typeof v === "boolean" ? v : fallback;
  };

  const locations: BusinessLocationDraft[] = [];
  if (Array.isArray(parsed.locations)) {
    for (const row of parsed.locations) {
      if (!row || typeof row !== "object") continue;
      const loc = row as Record<string, unknown>;
      const locationName = typeof loc.locationName === "string" ? loc.locationName.trim() : "";
      let city = typeof loc.city === "string" ? loc.city.trim() : "";
      let state = typeof loc.state === "string" ? loc.state.trim() : "";
      let address = typeof loc.address === "string" ? loc.address.trim() : "";
      if (isEmptyLocationValue(city)) city = "";
      if (isEmptyLocationValue(state)) state = "";
      if (isEmptyLocationValue(address)) address = "";
      if (!locationName && !city && !address) continue;
      locations.push({
        locationName: locationName || "Main Location",
        city,
        state,
        ...(address ? { address } : {}),
      });
    }
  }

  const businessName = str("businessName") || fallbackName;
  let city = isEmptyLocationValue(str("city")) ? "" : str("city");
  let state = isEmptyLocationValue(str("state")) ? "" : str("state");
  if (!city && locationHints.city) city = locationHints.city;
  if (!state && locationHints.state) state = locationHints.state;

  if (locations.length === 0) {
    locations.push({
      locationName: "Main Location",
      city,
      state,
      ...(locationHints.address ? { address: locationHints.address } : {}),
    });
  } else {
    const primary = locations[0];
    if (isEmptyLocationValue(primary.city) && city) primary.city = city;
    if (isEmptyLocationValue(primary.state) && state) primary.state = state;
    if (isEmptyLocationValue(primary.address) && locationHints.address) {
      primary.address = locationHints.address;
    }
  }

  const missingFields: string[] = [];
  if (!businessName) missingFields.push("Business name");
  if (!str("contactEmail")) missingFields.push("Contact email");
  if (!city && !state) missingFields.push("City / state");

  return {
    website,
    businessName,
    businessType: str("businessType") || "Restaurant",
    about: str("about"),
    contactEmail: str("contactEmail"),
    phone: str("phone"),
    city,
    state,
    locations,
    imageUrls,
    supportsDineAndDonate: bool("supportsDineAndDonate", true),
    supportsShopAndDonate: bool("supportsShopAndDonate", false),
    supportsServiceGiveback: bool("supportsServiceGiveback", false),
    supportsGuestBartending: bool("supportsGuestBartending", false),
    missingFields,
    confirmationStatus: "AI Draft",
    provider: aiProviderName(),
  };
}
