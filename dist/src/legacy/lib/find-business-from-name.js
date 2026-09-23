"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findBusinessFromName = findBusinessFromName;
const ai_chat_1 = require("./ai-chat");
const suggest_social_images_1 = require("./suggest-social-images");
const business_venue_images_1 = require("./business-venue-images");
const business_website_location_1 = require("./business-website-location");
const join_door_type_1 = require("./join-door-type");
const venue_page_extract_1 = require("./venue-page-extract");
function normalizeWebsite(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function suggestHostName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 40);
}
async function findBusinessFromName(input) {
    const businessName = input.businessName.trim();
    if (!businessName || businessName.length > 200) {
        throw new Error("Business name is required.");
    }
    const joinDoorType = (0, join_door_type_1.normalizeJoinDoorType)(input.joinDoorType);
    const doorLabel = joinDoorType === "local" ? "local business" : "restaurant";
    let website = "";
    let about = "";
    let contactEmail = "";
    let phone = "";
    let city = "";
    let state = "";
    let businessType = joinDoorType === "local" ? "Local Business" : "Restaurant";
    if ((0, ai_chat_1.aiProviderName)() !== "none") {
        const system = [
            `You help ForkUp find a public ${doorLabel} website from a business name.`,
            "Return ONLY JSON with keys: website, businessName, businessType, about, contactEmail, phone, city, state.",
            "website must be the official public homepage URL when reasonably known; otherwise guess the most likely official site.",
            "Never invent private emails or phones. Leave unknown fields as empty strings.",
            "Do not use placeholder phrases like 'Not provided on the website'.",
        ].join("\n");
        const content = await (0, ai_chat_1.aiChat)({
            system,
            user: `${doorLabel} name: ${businessName}`,
            json: true,
            maxTokens: 1024,
            temperature: 0.1,
        });
        try {
            const parsed = (0, ai_chat_1.parseAiJson)(content);
            const str = (k) => {
                const v = parsed[k];
                return typeof v === "string" ? v.trim() : "";
            };
            website = normalizeWebsite(str("website"));
            about = str("about");
            contactEmail = str("contactEmail");
            phone = str("phone");
            city = (0, business_website_location_1.isEmptyLocationValue)(str("city")) ? "" : str("city");
            state = (0, business_website_location_1.isEmptyLocationValue)(str("state")) ? "" : str("state");
            businessType = str("businessType") || businessType;
        }
        catch {
        }
    }
    if (!website) {
        const hostGuess = suggestHostName(businessName);
        if (hostGuess)
            website = `https://www.${hostGuess}.com`;
    }
    const hints = website
        ? await (0, business_website_location_1.scrapeBusinessLocationHints)(website)
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
    if ((0, business_website_location_1.isEmptyLocationValue)(city) && hints.city)
        city = hints.city;
    if ((0, business_website_location_1.isEmptyLocationValue)(state) && hints.state)
        state = hints.state;
    const address = hints.address;
    const zip = hints.zip;
    const [imageSuggestions, venuePhotos, pageCopy] = await Promise.all([
        website ? (0, suggest_social_images_1.suggestSocialImages)({ websiteUrl: website, limit: 10 }) : Promise.resolve([]),
        website
            ? (0, business_venue_images_1.scrapeBusinessVenueImages)({
                websiteUrl: website,
                reservationUrl: hints.reservationUrl,
                limit: 14,
            })
            : Promise.resolve([]),
        hints.pageText || hints.aboutHint || hints.hoursText
            ? (0, venue_page_extract_1.extractVenueCopyFromPage)(hints.pageText || hints.hoursText || hints.aboutHint, {
                aboutHint: hints.aboutHint,
                hoursText: hints.hoursText,
            })
            : Promise.resolve(null),
    ]);
    if (pageCopy?.about)
        about = pageCopy.about;
    else if (!about && hints.aboutHint)
        about = hints.aboutHint;
    const mergedImages = [
        ...venuePhotos,
        ...imageSuggestions.map((img) => img.url).filter(Boolean),
    ].filter((u) => u && !(0, suggest_social_images_1.looksLikeDecorativeAssetUrl)(u));
    const imageUrls = [...new Set(mergedImages)];
    const logoCandidate = imageUrls.find((u) => (0, suggest_social_images_1.looksLikeLogoUrl)(u)) ?? imageUrls[0] ?? null;
    const photoUrls = imageUrls.filter((u) => !(0, suggest_social_images_1.looksLikeLogoUrl)(u) && !(0, suggest_social_images_1.looksLikeDecorativeAssetUrl)(u));
    const locationFound = Boolean(city || state || address);
    const checks = {
        websiteFound: hints.websiteFound || Boolean(website),
        logoFound: Boolean(logoCandidate),
        photosFound: photoUrls.length > 0 || imageUrls.length > 0,
        locationFound,
    };
    const locations = locationFound || businessName
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
        provider: (0, ai_chat_1.aiProviderName)() === "none" ? "website_scrape" : (0, ai_chat_1.aiProviderName)(),
    };
}
//# sourceMappingURL=find-business-from-name.js.map