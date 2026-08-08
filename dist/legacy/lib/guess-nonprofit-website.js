"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guessNonprofitWebsite = guessNonprofitWebsite;
const ai_chat_1 = require("./ai-chat");
const known_organization_profiles_1 = require("./known-organization-profiles");
async function guessNonprofitWebsite(params) {
    const name = params.organizationName.trim();
    if (!name)
        return { website: null, provider: null };
    const known = (0, known_organization_profiles_1.findKnownOrganizationByName)(name);
    if (known?.website?.trim()) {
        return { website: normalizeWebsite(known.website), provider: "known_profile" };
    }
    if ((0, ai_chat_1.aiProviderName)() === "none") {
        return { website: null, provider: null };
    }
    const contextParts = [`Organization name: ${name}`];
    if (params.ein?.trim())
        contextParts.push(`EIN: ${params.ein.trim()}`);
    if (params.city?.trim() || params.state?.trim()) {
        contextParts.push(`Location: ${[params.city?.trim(), params.state?.trim()].filter(Boolean).join(", ")}`);
    }
    try {
        const content = await (0, ai_chat_1.aiChat)({
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
        let parsed = {};
        try {
            parsed = (0, ai_chat_1.parseAiJson)(content);
        }
        catch {
            return { website: null, provider: null };
        }
        const raw = typeof parsed.website === "string" ? parsed.website.trim() : "";
        if (!raw)
            return { website: null, provider: null };
        return { website: normalizeWebsite(raw), provider: (0, ai_chat_1.aiProviderName)() };
    }
    catch {
        return { website: null, provider: null };
    }
}
function normalizeWebsite(raw) {
    const t = raw.trim();
    if (!t)
        return null;
    if (/^https?:\/\//i.test(t))
        return t;
    if (/^[a-z0-9][-a-z0-9.]*\.[a-z]{2,}/i.test(t))
        return `https://${t}`;
    return null;
}
//# sourceMappingURL=guess-nonprofit-website.js.map