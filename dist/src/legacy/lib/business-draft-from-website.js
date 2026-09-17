"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBusinessDraftFromWebsite = generateBusinessDraftFromWebsite;
const ai_chat_1 = require("./ai-chat");
const suggest_social_images_1 = require("./suggest-social-images");
const business_website_location_1 = require("./business-website-location");
function normalizeWebsiteInput(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function suggestNameFromHost(website) {
    try {
        const host = new URL(normalizeWebsiteInput(website)).hostname.replace(/^www\./, "");
        const base = host.split(".")[0] ?? "";
        if (!base)
            return "";
        return base.charAt(0).toUpperCase() + base.slice(1);
    }
    catch {
        return "";
    }
}
async function generateBusinessDraftFromWebsite(websiteInput) {
    const website = normalizeWebsiteInput(websiteInput);
    if (!website || website.length > 2048) {
        throw new Error("A valid website URL is required.");
    }
    const imageSuggestions = await (0, suggest_social_images_1.suggestSocialImages)({ websiteUrl: website, limit: 6 });
    const imageUrls = imageSuggestions.map((img) => img.url).filter(Boolean);
    const fallbackName = suggestNameFromHost(website);
    const locationHints = await (0, business_website_location_1.scrapeBusinessLocationHints)(website);
    if ((0, ai_chat_1.aiProviderName)() === "none") {
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
    const content = await (0, ai_chat_1.aiChat)({
        system,
        user: `Business website: ${website}${pageBlock}`,
        json: true,
        maxTokens: 2048,
        temperature: 0.2,
    });
    let parsed = {};
    try {
        parsed = (0, ai_chat_1.parseAiJson)(content);
    }
    catch {
        parsed = {};
    }
    const str = (key) => {
        const v = parsed[key];
        return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    };
    const bool = (key, fallback = false) => {
        const v = parsed[key];
        return typeof v === "boolean" ? v : fallback;
    };
    const locations = [];
    if (Array.isArray(parsed.locations)) {
        for (const row of parsed.locations) {
            if (!row || typeof row !== "object")
                continue;
            const loc = row;
            const locationName = typeof loc.locationName === "string" ? loc.locationName.trim() : "";
            let city = typeof loc.city === "string" ? loc.city.trim() : "";
            let state = typeof loc.state === "string" ? loc.state.trim() : "";
            let address = typeof loc.address === "string" ? loc.address.trim() : "";
            if ((0, business_website_location_1.isEmptyLocationValue)(city))
                city = "";
            if ((0, business_website_location_1.isEmptyLocationValue)(state))
                state = "";
            if ((0, business_website_location_1.isEmptyLocationValue)(address))
                address = "";
            if (!locationName && !city && !address)
                continue;
            locations.push({
                locationName: locationName || "Main Location",
                city,
                state,
                ...(address ? { address } : {}),
            });
        }
    }
    const businessName = str("businessName") || fallbackName;
    let city = (0, business_website_location_1.isEmptyLocationValue)(str("city")) ? "" : str("city");
    let state = (0, business_website_location_1.isEmptyLocationValue)(str("state")) ? "" : str("state");
    if (!city && locationHints.city)
        city = locationHints.city;
    if (!state && locationHints.state)
        state = locationHints.state;
    if (locations.length === 0) {
        locations.push({
            locationName: "Main Location",
            city,
            state,
            ...(locationHints.address ? { address: locationHints.address } : {}),
        });
    }
    else {
        const primary = locations[0];
        if ((0, business_website_location_1.isEmptyLocationValue)(primary.city) && city)
            primary.city = city;
        if ((0, business_website_location_1.isEmptyLocationValue)(primary.state) && state)
            primary.state = state;
        if ((0, business_website_location_1.isEmptyLocationValue)(primary.address) && locationHints.address) {
            primary.address = locationHints.address;
        }
    }
    const missingFields = [];
    if (!businessName)
        missingFields.push("Business name");
    if (!str("contactEmail"))
        missingFields.push("Contact email");
    if (!city && !state)
        missingFields.push("City / state");
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
        provider: (0, ai_chat_1.aiProviderName)(),
    };
}
//# sourceMappingURL=business-draft-from-website.js.map