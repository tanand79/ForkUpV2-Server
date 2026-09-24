/**
 * Pass D1 — find a restaurant/local business profile from a public name.
 *
 * Purpose: Support mockup Step 1 “Find My Restaurant/Business” — AI suggests a
 * website from the name, then real HTML scrape fills location + photo checks.
 *
 * Inputs: businessName, optional joinDoorType (restaurant | local),
 *         optional nearZip / city / state for nearby store resolution.
 * Outputs: confirmation payload (name, website, city/state/address, images,
 *          social links, checks).
 *
 * Changelog (D1): Added — name → website (AI) + scrape + social/website images.
 * Changelog: Include a booking-platform URL when the business site links one.
 * Changelog: Nearby ZIP/city resolves a specific store (not “Location to confirm”);
 *            discover Facebook / Instagram / LinkedIn / YouTube from the site.
 * Changelog: Optional website override — prefer known DB URL over AI host guess.
 * Changelog: Optional businessId — persist discovered public social/contact into businesses.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import {
  discoverSocialLinksFromWebsite,
  looksLikeDecorativeAssetUrl,
  looksLikeLogoUrl,
  suggestSocialImages,
} from "./suggest-social-images";
import { scrapeBusinessVenueImages } from "./business-venue-images";
import {
  isEmptyLocationValue,
  scrapeBusinessLocationHints,
} from "./business-website-location";
import { extractVenueCopyFromPage, type VenuePageCopy } from "./venue-page-extract";
import { normalizeJoinDoorType, type JoinDoorType } from "./join-door-type";
import { searchNamedBusinessNear } from "./geo-distance";
import { persistBusinessPublicLinks, persistBusinessGalleryUrls } from "./persist-business-public-links";

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
  /** Additive: public social profile URLs discovered from the website. */
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
  tiktokUrl: string | null;
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

function cleanNearZip(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "").slice(0, 5);
}

/**
 * Resolve a reviewable business “we found you” card from a typed name.
 */
export async function findBusinessFromName(input: {
  businessName: string;
  joinDoorType?: unknown;
  /** US ZIP — prefer a store near this area (NPO-style nearby). */
  nearZip?: unknown;
  city?: unknown;
  state?: unknown;
  /** Known public website (from DB / campaign card) — skip AI host guess when set. */
  website?: unknown;
  /** When set, persist discovered public social/contact onto this business (null-only). */
  businessId?: unknown;
}): Promise<FindBusinessFromNameResult> {
  const businessName = input.businessName.trim();
  if (!businessName || businessName.length > 200) {
    throw new Error("Business name is required.");
  }
  const joinDoorType = normalizeJoinDoorType(input.joinDoorType);
  const doorLabel = joinDoorType === "local" ? "local business" : "restaurant";
  const nearZip = cleanNearZip(input.nearZip);
  const nearCity = typeof input.city === "string" ? input.city.trim() : "";
  const nearState =
    typeof input.state === "string"
      ? input.state.trim().toUpperCase().slice(0, 2)
      : "";
  const knownWebsite =
    typeof input.website === "string" ? normalizeWebsite(input.website) : "";
  const businessIdRaw = Number(input.businessId);
  const businessId =
    Number.isFinite(businessIdRaw) && businessIdRaw > 0 ? businessIdRaw : null;

  let website = knownWebsite;
  let about = "";
  let contactEmail = "";
  let phone = "";
  let city = "";
  let state = "";
  let aiAddress = "";
  let aiZip = "";
  let businessType = joinDoorType === "local" ? "Local Business" : "Restaurant";

  if (!website && aiProviderName() !== "none") {
    const nearHint =
      nearZip.length === 5
        ? `Near US ZIP ${nearZip}. Return the specific store location closest to that ZIP (street address, city, state, zip) — not corporate HQ.`
        : nearCity || nearState
          ? `Near ${[nearCity, nearState].filter(Boolean).join(", ")}. Return the specific store closest to that area.`
          : "If this is a chain, prefer a well-known flagship or leave city/state empty rather than inventing an address.";
    const system = [
      `You help ForkUp find a public ${doorLabel} website from a business name.`,
      "Return ONLY JSON with keys: website, businessName, businessType, about, contactEmail, phone, city, state, address, zip.",
      "website must be the official public homepage URL when reasonably known; otherwise guess the most likely official site.",
      nearHint,
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
      aiAddress = isEmptyLocationValue(str("address")) ? "" : str("address");
      aiZip = cleanNearZip(str("zip"));
    } catch {
      /* scrape may still help if we can guess a host */
    }
  }

  if (!website) {
    const hostGuess = suggestHostName(businessName);
    if (hostGuess) website = `https://www.${hostGuess}.com`;
  }

  const emptyHints = {
    address: "",
    city: "",
    state: "",
    zip: "",
    pageText: "",
    sourceUrl: null as string | null,
    websiteFound: false,
    reservationUrl: null as string | null,
    bookingPlatform: null as string | null,
    bookingLabel: null as string | null,
    aboutHint: "",
    hoursText: "",
  };
  const emptySocial = {
    facebookUrl: null as string | null,
    instagramUrl: null as string | null,
    linkedinUrl: null as string | null,
    youtubeUrl: null as string | null,
    tiktokUrl: null as string | null,
    phone: null as string | null,
    email: null as string | null,
  };

  // Social in parallel with location — do not wait for a hung apex crawl first.
  const [hints, social] = await Promise.all([
    website ? scrapeBusinessLocationHints(website) : Promise.resolve(emptyHints),
    website ? discoverSocialLinksFromWebsite(website) : Promise.resolve(emptySocial),
  ]);

  if (isEmptyLocationValue(city) && hints.city) city = hints.city;
  if (isEmptyLocationValue(state) && hints.state) state = hints.state;
  let address = hints.address || aiAddress;
  let zip = hints.zip || aiZip || nearZip;

  // Chain HQ sites often have no store address — resolve a nearby place like NPO ZIP search.
  const needsNearby =
    (!city && !state && !address) ||
    nearZip.length === 5 ||
    Boolean(nearCity && nearState);
  if (needsNearby && (nearZip.length === 5 || nearCity || nearState)) {
    const nearby = await searchNamedBusinessNear(businessName, {
      zip: nearZip || zip,
      city: nearCity || city,
      state: nearState || state,
    });
    if (nearby) {
      if (nearby.address) address = nearby.address;
      if (nearby.city) city = nearby.city;
      if (nearby.state) state = nearby.state;
      if (nearby.zip) zip = nearby.zip;
    }
  }

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
  if (!phone && social.phone) phone = social.phone;
  if (!contactEmail && social.email) contactEmail = social.email;

  if (businessId) {
    await persistBusinessPublicLinks(businessId, {
      website: website || null,
      facebookUrl: social.facebookUrl,
      instagramUrl: social.instagramUrl,
      linkedinUrl: social.linkedinUrl,
      tiktokUrl: social.tiktokUrl,
      phone: social.phone,
      venueEmail: social.email,
    });
  }

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

  if (businessId && photoUrls.length > 0) {
    await persistBusinessGalleryUrls(businessId, photoUrls);
  }

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
    facebookUrl: social.facebookUrl,
    instagramUrl: social.instagramUrl,
    linkedinUrl: social.linkedinUrl,
    youtubeUrl: social.youtubeUrl,
    tiktokUrl: social.tiktokUrl,
    checks,
    locationSourceUrl: hints.sourceUrl,
    joinDoorType,
    confirmationStatus: "Find Draft",
    provider: aiProviderName() === "none" ? "website_scrape" : aiProviderName(),
  };
}
