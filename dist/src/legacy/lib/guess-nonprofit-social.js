"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guessNonprofitSocialLinks = guessNonprofitSocialLinks;
const ai_chat_1 = require("./ai-chat");
const suggest_social_images_1 = require("./suggest-social-images");
const VERIFY_TIMEOUT_MS = 6_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
async function isReachablePublicUrl(url) {
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
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
async function guessNonprofitSocialLinks(params) {
    const empty = {
        facebookUrl: null,
        instagramUrl: null,
        linkedinUrl: null,
        youtubeUrl: null,
        provider: null,
    };
    const name = params.organizationName.trim();
    if (!name)
        return empty;
    if ((0, ai_chat_1.aiProviderName)() === "none") {
        return empty;
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
        let parsed = {};
        try {
            parsed = (0, ai_chat_1.parseAiJson)(content);
        }
        catch {
            return empty;
        }
        const rawFb = typeof parsed.facebookUrl === "string" ? parsed.facebookUrl.trim() : "";
        const rawIg = typeof parsed.instagramUrl === "string" ? parsed.instagramUrl.trim() : "";
        const rawLi = typeof parsed.linkedinUrl === "string" ? parsed.linkedinUrl.trim() : "";
        const rawYt = typeof parsed.youtubeUrl === "string" ? parsed.youtubeUrl.trim() : "";
        const facebookCandidate = rawFb ? (0, suggest_social_images_1.normalizeFacebookUrl)(rawFb) : null;
        const instagramCandidate = rawIg ? (0, suggest_social_images_1.normalizeInstagramUrl)(rawIg) : null;
        const linkedinCandidate = rawLi ? (0, suggest_social_images_1.normalizeLinkedInUrl)(rawLi) : null;
        const youtubeCandidate = rawYt ? (0, suggest_social_images_1.normalizeYouTubeUrl)(rawYt) : null;
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
            provider: (0, ai_chat_1.aiProviderName)(),
        };
    }
    catch {
        return empty;
    }
}
//# sourceMappingURL=guess-nonprofit-social.js.map