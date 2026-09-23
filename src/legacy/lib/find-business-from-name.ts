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
 * Changelog: Include a booking-platform URL when the business site links one.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { looksLikeDecorativeAssetUrl, looksLikeLogoUrl, suggestSocialImages } from "./suggest-social-images";
import { scrapeBusinessVenueImages } from "./business-venue-images";
import {
  isEmptyLocationValue,
  scrapeBusinessLocationHints,
} from "./business-website-location";
import { normalizeJoinDoorType, type JoinDoorType } from "./join-door-type";
import { extractVenueCopyFromPage, type VenuePageCopy } from "./venue-page-extract";

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
    reservationUrl?: string;
  }>;
  reservationUrl: string | null;
  bookingPlatform: string | null;
  logoUrl: string | null;
  imageUrls: string[];
  /** Weekday labels taken from the public site. Null when the page listed none. */
  discountHours: VenuePageCopy["discountHours"] | null;
  /** Time range from the site, when one was stated. */
  eligibleWindow: string;
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
        reservationUrl: null,
        bookingPlatform: null,
        bookingLabel: null,
        aboutHint: "",
        hoursText: "",
      };

  if (isEmptyLocationValue(city) && hints.city) city = hints.city;
  if (isEmptyLocationValue(state) && hints.state) state = hints.state;
  const address = hints.address;
  const zip = hints.zip;

  const [imageSuggestions, venuePhotos, pageCopy] = await Promise.all([
    website ? suggestSocialImages({ websiteUrl: website, limit: 10 }) : Promise.resolve([]),
    website
      ? scrapeBusinessVenueImages({
          websiteUrl: website,
          reservationUrl: hints.reservationUrl,
          limit: 14,
        })
      : Promise.resolve([]),
    hints.pageText || hints.aboutHint || hints.hoursText
      ? extractVenueCopyFromPage(hints.pageText || hints.hoursText || hints.aboutHint, {
          aboutHint: hints.aboutHint,
          hoursText: hints.hoursText,
        })
      : Promise.resolve(null),
  ]);
  if (pageCopy?.about) about = pageCopy.about;
  else if (!about && hints.aboutHint) about = hints.aboutHint;
  const mergedImages = [
    ...venuePhotos,
    ...imageSuggestions.map((img) => img.url).filter(Boolean),
  ].filter((u) => u && !looksLikeDecorativeAssetUrl(u));
  const imageUrls = [...new Set(mergedImages)];
  const logoCandidate =
    imageUrls.find((u) => looksLikeLogoUrl(u)) ?? imageUrls[0] ?? null;
  const photoUrls = imageUrls.filter(
    (u) => !looksLikeLogoUrl(u) && !looksLikeDecorativeAssetUrl(u),
  );

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
            ...(hints.reservationUrl ? { reservationUrl: hints.reservationUrl } : {}),
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
    reservationUrl: hints.reservationUrl,
    bookingPlatform: hints.bookingPlatform,
    logoUrl: logoCandidate,
    imageUrls,
    discountHours: pageCopy?.discountHours ?? null,
    eligibleWindow: pageCopy?.eligibleWindow ?? "",
    checks,
    locationSourceUrl: hints.sourceUrl,
    joinDoorType,
    confirmationStatus: "Find Draft",
    provider: aiProviderName() === "none" ? "website_scrape" : aiProviderName(),
  };
}
