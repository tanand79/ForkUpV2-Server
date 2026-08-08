"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractOrgPageMeta = extractOrgPageMeta;
exports.resolveAnalysisSources = resolveAnalysisSources;
exports.generateCampaignIdeasFromAnalysis = generateCampaignIdeasFromAnalysis;
exports.getAnalysisSessionByToken = getAnalysisSessionByToken;
exports.runOrganizationAiCampaignFlow = runOrganizationAiCampaignFlow;
const crypto_1 = require("crypto");
const pool_1 = require("../db/pool");
const ai_chat_1 = require("./ai-chat");
const guess_nonprofit_website_1 = require("./guess-nonprofit-website");
const guess_nonprofit_social_1 = require("./guess-nonprofit-social");
const known_organization_profiles_1 = require("./known-organization-profiles");
const suggest_social_images_1 = require("./suggest-social-images");
const SESSION_TTL_DAYS = 7;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const METHOD_VALUES = [
    "donations",
    "ambassador",
    "giveback",
    "guestBartending",
];
function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}
function toIso(value) {
    if (value instanceof Date)
        return value.toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
function newSessionToken() {
    return (0, crypto_1.randomBytes)(32).toString("hex");
}
function sessionExpiry() {
    const d = new Date();
    d.setDate(d.getDate() + SESSION_TTL_DAYS);
    return d;
}
function clampConfidence(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
}
function parseSuggestedGoal(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.round(value);
    }
    if (typeof value === "string") {
        const digits = value.replace(/[^0-9.]/g, "");
        if (!digits)
            return null;
        const n = Number.parseFloat(digits);
        if (!Number.isFinite(n) || n <= 0)
            return null;
        return Math.round(n);
    }
    return null;
}
function normalizeMethods(value) {
    if (!Array.isArray(value))
        return ["donations", "ambassador"];
    const out = [];
    for (const item of value) {
        const raw = trimStr(item);
        if (!raw)
            continue;
        const mapped = raw === "online_donations" || raw === "virtual_donations"
            ? "donations"
            : raw === "ambassador_fundraising"
                ? "ambassador"
                : raw === "dine_and_donate" || raw === "shop_and_donate" || raw === "service_giveback"
                    ? "giveback"
                    : raw === "guest_bartending_event"
                        ? "guestBartending"
                        : raw;
        if (METHOD_VALUES.includes(mapped) && !out.includes(mapped)) {
            out.push(mapped);
        }
    }
    return out.length ? out : ["donations", "ambassador"];
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
function metaContent(html, patterns) {
    for (const re of patterns) {
        const m = re.exec(html);
        if (m?.[1])
            return decodeHtmlEntities(m[1].trim());
    }
    return "";
}
async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
        if (!res.ok)
            return null;
        const buf = Buffer.from(await res.arrayBuffer());
        const slice = buf.length > MAX_HTML_BYTES ? buf.subarray(0, MAX_HTML_BYTES) : buf;
        return slice.toString("utf8");
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function extractOrgPageMeta(websiteUrl) {
    const normalized = (0, suggest_social_images_1.normalizeWebsiteUrl)(websiteUrl);
    if (!normalized)
        return null;
    const html = await fetchHtml(normalized);
    if (!html)
        return null;
    const title = metaContent(html, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
        /<title[^>]*>([^<]+)<\/title>/i,
    ]);
    const description = metaContent(html, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    ]);
    if (!title && !description)
        return null;
    return {
        title: title.slice(0, 300),
        description: description.slice(0, 1000),
        sourceUrl: normalized,
    };
}
async function loadNonprofit(id) {
    const { rows } = await pool_1.pool.query(`SELECT id, organization_name, website, mission, cause_category, ein, city, state,
            facebook_url, instagram_url, linkedin_url
       FROM nonprofits
      WHERE id = $1
      LIMIT 1`, [id]);
    return rows[0] ?? null;
}
async function resolveAnalysisSources(input) {
    const organizationName = trimStr(input.organizationName);
    let nonprofitId = typeof input.nonprofitId === "number" && Number.isFinite(input.nonprofitId) && input.nonprofitId > 0
        ? Math.floor(input.nonprofitId)
        : null;
    let website = (0, suggest_social_images_1.normalizeWebsiteUrl)(trimStr(input.website));
    let facebookUrl = (0, suggest_social_images_1.normalizeFacebookUrl)(trimStr(input.facebookUrl));
    let instagramRaw = trimStr(input.instagramUrl);
    let linkedinUrl = trimStr(input.linkedinUrl) || null;
    let youtubeUrl = (0, suggest_social_images_1.normalizeYouTubeUrl)(trimStr(input.youtubeUrl) || "") || null;
    let mission = trimStr(input.mission) || null;
    let causeCategory = trimStr(input.causeCategory) || null;
    let ein = trimStr(input.ein) || null;
    let city = trimStr(input.city) || null;
    let state = trimStr(input.state) || null;
    if (nonprofitId) {
        const row = await loadNonprofit(nonprofitId);
        if (row) {
            if (!website)
                website = (0, suggest_social_images_1.normalizeWebsiteUrl)(row.website || "");
            if (!facebookUrl)
                facebookUrl = (0, suggest_social_images_1.normalizeFacebookUrl)(row.facebook_url || "");
            if (!instagramRaw)
                instagramRaw = trimStr(row.instagram_url);
            if (!linkedinUrl)
                linkedinUrl = trimStr(row.linkedin_url) || null;
            if (!mission)
                mission = trimStr(row.mission) || null;
            if (!causeCategory)
                causeCategory = trimStr(row.cause_category) || null;
            if (!ein)
                ein = trimStr(row.ein) || null;
            if (!city)
                city = trimStr(row.city) || null;
            if (!state)
                state = trimStr(row.state) || null;
            if (!organizationName) {
            }
        }
        else {
            nonprofitId = null;
        }
    }
    const known = (website ? (0, known_organization_profiles_1.findKnownOrganizationProfile)(website) : null) ||
        (0, known_organization_profiles_1.findKnownOrganizationByName)(organizationName);
    if (known) {
        if (!website)
            website = (0, suggest_social_images_1.normalizeWebsiteUrl)(known.website || "");
        if (!mission)
            mission = trimStr(known.missionStatement) || null;
        if (!causeCategory)
            causeCategory = trimStr(known.causeCategory) || null;
        if (!ein)
            ein = trimStr(known.ein) || null;
        if (!city)
            city = trimStr(known.city) || null;
        if (!state)
            state = trimStr(known.state) || null;
        const social = Array.isArray(known.social) ? known.social : [];
        if (!facebookUrl && social.includes("Facebook") && known.website) {
        }
    }
    if (!website) {
        const guessed = await (0, guess_nonprofit_website_1.guessNonprofitWebsite)({
            organizationName,
            ein,
            city,
            state,
        });
        if (guessed.website)
            website = (0, suggest_social_images_1.normalizeWebsiteUrl)(guessed.website);
    }
    if (website && (!facebookUrl || !instagramRaw || !linkedinUrl || !youtubeUrl)) {
        const discovered = await (0, suggest_social_images_1.discoverSocialLinksFromWebsite)(website);
        if (!facebookUrl && discovered.facebookUrl) {
            facebookUrl = discovered.facebookUrl;
        }
        if (!instagramRaw && discovered.instagramUrl) {
            instagramRaw = discovered.instagramUrl;
        }
        if (!linkedinUrl && discovered.linkedinUrl) {
            linkedinUrl = discovered.linkedinUrl;
        }
        if (!youtubeUrl && discovered.youtubeUrl) {
            youtubeUrl = discovered.youtubeUrl;
        }
    }
    if (!facebookUrl || !instagramRaw || !linkedinUrl || !youtubeUrl) {
        const guessedSocial = await (0, guess_nonprofit_social_1.guessNonprofitSocialLinks)({
            organizationName,
            ein,
            city,
            state,
        });
        if (!facebookUrl && guessedSocial.facebookUrl) {
            facebookUrl = guessedSocial.facebookUrl;
        }
        if (!instagramRaw && guessedSocial.instagramUrl) {
            instagramRaw = guessedSocial.instagramUrl;
        }
        if (!linkedinUrl && guessedSocial.linkedinUrl) {
            linkedinUrl = guessedSocial.linkedinUrl;
        }
        if (!youtubeUrl && guessedSocial.youtubeUrl) {
            youtubeUrl = guessedSocial.youtubeUrl;
        }
    }
    const instagramUrl = instagramRaw
        ? (0, suggest_social_images_1.normalizeInstagramUrl)(instagramRaw) || instagramRaw
        : null;
    return {
        organizationName,
        ein,
        nonprofitId,
        website,
        facebookUrl,
        instagramUrl,
        linkedinUrl,
        youtubeUrl,
        mission,
        causeCategory,
        city,
        state,
    };
}
async function generateCampaignIdeasFromAnalysis(params) {
    if ((0, ai_chat_1.aiProviderName)() === "none") {
        throw new Error("No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.");
    }
    const system = [
        "You are a nonprofit fundraising strategist for the ForkUp platform.",
        "Given organization context scraped/known from public website/social signals, propose 3 or 4 distinct campaign ideas.",
        "Never invent past fundraising results, donor counts, or claims of verified partnerships.",
        "Methods must be chosen from: donations, ambassador, giveback, guestBartending.",
        "Prefer donations + ambassador for most community orgs; recommend giveback/guestBartending only when local in-person fundraising fits.",
        "confidence is 0-100 how well the idea fits the org signals.",
        "suggestedGoal is a whole USD integer recommendation (typically 2500-25000).",
        'Return ONLY minified JSON: {"summary": string, "themes": string[], "ideas": [{"title": string, "description": string, "confidence": number, "suggestedGoal": number, "suggestedMethods": string[]}]}',
        "Do not include markdown, code fences, or commentary.",
    ].join("\n");
    const userParts = [
        `Organization: ${params.organizationName}`,
        params.mission ? `Mission: ${params.mission}` : "",
        params.causeCategory ? `Cause category: ${params.causeCategory}` : "",
        params.city || params.state
            ? `Location: ${[params.city, params.state].filter(Boolean).join(", ")}`
            : "",
        params.pageMeta?.title ? `Website title: ${params.pageMeta.title}` : "",
        params.pageMeta?.description ? `Website description: ${params.pageMeta.description}` : "",
        `Public images found: ${params.imageCount}`,
    ].filter(Boolean);
    const raw = await (0, ai_chat_1.aiChat)({
        system,
        user: userParts.join("\n"),
        json: true,
        maxTokens: 2048,
        temperature: 0.45,
    });
    let parsed = {};
    try {
        parsed = (0, ai_chat_1.parseAiJson)(raw);
    }
    catch {
        parsed = {};
    }
    const themes = Array.isArray(parsed.themes)
        ? parsed.themes
            .filter((t) => typeof t === "string" && t.trim().length > 0)
            .map((t) => t.trim().slice(0, 80))
            .slice(0, 8)
        : [];
    const summary = typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 500)
        : `Campaign ideas prepared for ${params.organizationName}.`;
    const ideasRaw = Array.isArray(parsed.ideas) ? parsed.ideas : [];
    const ideas = ideasRaw
        .map((idea) => {
        const title = trimStr(idea.title).slice(0, 255);
        const description = trimStr(idea.description).slice(0, 1000);
        if (!title)
            return null;
        return {
            title,
            description: description || title,
            confidence: clampConfidence(idea.confidence),
            suggestedGoal: parseSuggestedGoal(idea.suggestedGoal),
            suggestedMethods: normalizeMethods(idea.suggestedMethods),
        };
    })
        .filter((x) => Boolean(x))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 4);
    if (!ideas.length) {
        ideas.push({
            title: `${params.organizationName} Community Fundraiser`,
            description: "A flexible community campaign with online donations and ambassador sharing — edit anytime.",
            confidence: 70,
            suggestedGoal: 10000,
            suggestedMethods: ["donations", "ambassador"],
        });
    }
    return {
        summary,
        themes,
        ideas,
        provider: (0, ai_chat_1.aiProviderName)(),
    };
}
function mapIdeaRow(row) {
    const goal = row.suggested_goal == null || row.suggested_goal === ""
        ? null
        : Number(row.suggested_goal);
    return {
        id: row.id,
        title: row.title,
        description: row.description || "",
        confidence: clampConfidence(row.confidence),
        thumbnailUrl: row.thumbnail_url,
        suggestedGoal: Number.isFinite(goal) && goal > 0 ? Math.round(goal) : null,
        suggestedMethods: normalizeMethods(row.suggested_methods),
        payload: row.payload_json && typeof row.payload_json === "object"
            ? row.payload_json
            : null,
        sortOrder: Number(row.sort_order) || 0,
    };
}
function mapSessionRow(row, ideas) {
    const status = row.status;
    let analysis = null;
    if (row.analysis_json && typeof row.analysis_json === "object") {
        analysis = row.analysis_json;
    }
    return {
        id: row.id,
        sessionToken: row.session_token,
        nonprofitId: row.nonprofit_id,
        organizationName: row.organization_name,
        ein: row.ein,
        website: row.website,
        facebookUrl: row.facebook_url,
        instagramUrl: row.instagram_url,
        linkedinUrl: row.linkedin_url,
        status,
        analysis,
        errorMessage: row.error_message,
        expiresAt: toIso(row.expires_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        ideas,
    };
}
async function loadIdeasForSession(sessionId) {
    const { rows } = await pool_1.pool.query(`SELECT id, title, description, confidence, thumbnail_url, suggested_goal,
            suggested_methods, payload_json, sort_order
       FROM organization_ai_campaign_ideas
      WHERE analysis_session_id = $1
      ORDER BY sort_order ASC, confidence DESC, id ASC`, [sessionId]);
    return rows.map(mapIdeaRow);
}
async function getAnalysisSessionByToken(sessionToken) {
    const token = trimStr(sessionToken);
    if (!token)
        return null;
    const { rows } = await pool_1.pool.query(`SELECT id, session_token, nonprofit_id, organization_name, ein, website,
            facebook_url, instagram_url, linkedin_url, status, analysis_json,
            error_message, expires_at, created_at, updated_at
       FROM organization_ai_analysis_sessions
      WHERE session_token = $1
      LIMIT 1`, [token]);
    const row = rows[0];
    if (!row)
        return null;
    const expiresAt = new Date(row.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
        return null;
    }
    const ideas = await loadIdeasForSession(row.id);
    return mapSessionRow(row, ideas);
}
async function runOrganizationAiCampaignFlow(input) {
    const organizationName = trimStr(input.organizationName);
    if (!organizationName) {
        throw new Error("organizationName is required.");
    }
    const sources = await resolveAnalysisSources(input);
    const sessionToken = newSessionToken();
    const expiresAt = sessionExpiry();
    const insert = await pool_1.pool.query(`INSERT INTO organization_ai_analysis_sessions (
       session_token, nonprofit_id, organization_name, ein, website,
       facebook_url, instagram_url, linkedin_url, status,
       created_by_user_id, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'running',
       $9, $10
     )
     RETURNING id, session_token, nonprofit_id, organization_name, ein, website,
               facebook_url, instagram_url, linkedin_url, status, analysis_json,
               error_message, expires_at, created_at, updated_at`, [
        sessionToken,
        sources.nonprofitId,
        sources.organizationName,
        sources.ein,
        sources.website,
        sources.facebookUrl,
        sources.instagramUrl,
        sources.linkedinUrl,
        input.createdByUserId ?? null,
        expiresAt,
    ]);
    const session = insert.rows[0];
    try {
        const [pageMeta, images] = await Promise.all([
            sources.website ? extractOrgPageMeta(sources.website) : Promise.resolve(null),
            (0, suggest_social_images_1.suggestSocialImages)({
                websiteUrl: sources.website || undefined,
                facebookUrl: sources.facebookUrl || undefined,
                instagramHandle: sources.instagramUrl || undefined,
                limit: 6,
            }),
        ]);
        const mission = sources.mission || pageMeta?.description || null;
        const ai = await generateCampaignIdeasFromAnalysis({
            organizationName: sources.organizationName,
            mission,
            causeCategory: sources.causeCategory,
            city: sources.city,
            state: sources.state,
            pageMeta,
            imageCount: images.length,
        });
        const analysis = {
            organizationName: sources.organizationName,
            ein: sources.ein,
            website: sources.website,
            facebookUrl: sources.facebookUrl,
            instagramUrl: sources.instagramUrl,
            linkedinUrl: sources.linkedinUrl,
            mission,
            causeCategory: sources.causeCategory,
            city: sources.city,
            state: sources.state,
            pageMeta,
            images,
            themes: ai.themes,
            summary: ai.summary,
            provider: ai.provider,
        };
        await pool_1.pool.query(`UPDATE organization_ai_analysis_sessions
          SET status = 'completed',
              analysis_json = $2::json,
              error_message = NULL,
              website = COALESCE(website, $3),
              facebook_url = COALESCE(facebook_url, $4),
              instagram_url = COALESCE(instagram_url, $5),
              linkedin_url = COALESCE(linkedin_url, $6)
        WHERE id = $1`, [
            session.id,
            JSON.stringify(analysis),
            sources.website,
            sources.facebookUrl,
            sources.instagramUrl,
            sources.linkedinUrl,
        ]);
        for (let i = 0; i < ai.ideas.length; i++) {
            const idea = ai.ideas[i];
            const thumbnail = images[i]?.url || images[0]?.url || null;
            await pool_1.pool.query(`INSERT INTO organization_ai_campaign_ideas (
           analysis_session_id, title, description, confidence, thumbnail_url,
           suggested_goal, suggested_methods, payload_json, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8::json, $9)`, [
                session.id,
                idea.title,
                idea.description,
                idea.confidence,
                thumbnail,
                idea.suggestedGoal,
                JSON.stringify(idea.suggestedMethods),
                JSON.stringify({
                    themes: ai.themes,
                    summary: ai.summary,
                }),
                i,
            ]);
        }
        const loaded = await getAnalysisSessionByToken(sessionToken);
        if (!loaded) {
            throw new Error("Analysis completed but session could not be reloaded.");
        }
        return loaded;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Analysis failed.";
        await pool_1.pool.query(`UPDATE organization_ai_analysis_sessions
          SET status = 'failed', error_message = $2
        WHERE id = $1`, [session.id, message.slice(0, 2000)]);
        throw err instanceof Error ? err : new Error(message);
    }
}
//# sourceMappingURL=organization-ai-campaign-flow.js.map