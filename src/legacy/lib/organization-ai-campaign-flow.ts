/**
 * Pre-campaign AI flow (backend Steps 3–4 + Step 5 idea generation).
 *
 * Purpose:
 * - After org select, silently analyze website + known social URLs.
 * - Persist an analysis session + ranked campaign idea cards for resume.
 *
 * Inputs: organization identity + optional website/social/mission/location.
 * Outputs: session token, analysis payload, idea cards (confidence-ranked).
 *
 * Guest campaign draft body is NOT stored here (browser localStorage).
 *
 * Changelog: Pass linkedinUrl/youtubeUrl into suggestSocialImages so post
 * extractor can pull captions + images after Nova/website URL discovery.
 * Additive: persist youtubeUrl inside analysis_json for resume/hydrate.
 * Additive: draftCampaignFromPurpose for AI-flow scratch path (title+story).
 * Additive: fitVarchar clamps website/social/thumbnail to VARCHAR(512) before INSERT.
 */
import { randomBytes } from "crypto";
import type { QueryResultRow } from "pg";
import { pool } from "../db/pool";
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";
import { guessNonprofitWebsite } from "./guess-nonprofit-website";
import { guessNonprofitSocialLinks } from "./guess-nonprofit-social";
import { findKnownOrganizationByName, findKnownOrganizationProfile } from "./known-organization-profiles";
import {
  normalizeFacebookUrl,
  normalizeInstagramUrl,
  normalizeWebsiteUrl,
  normalizeYouTubeUrl,
  suggestSocialImages,
  discoverSocialLinksFromWebsite,
  type SuggestedImage,
} from "./suggest-social-images";

const SESSION_TTL_DAYS = 7;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const METHOD_VALUES = [
  "donations",
  "ambassador",
  "giveback",
  "guestBartending",
] as const;

export type AiCampaignMethod = (typeof METHOD_VALUES)[number];

export type AnalyzeOrgInput = {
  organizationName: string;
  ein?: string | null;
  nonprofitId?: number | null;
  website?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  /** Additive: optional YouTube channel URL (resolve/prefill). */
  youtubeUrl?: string | null;
  mission?: string | null;
  causeCategory?: string | null;
  city?: string | null;
  state?: string | null;
  createdByUserId?: number | null;
};

export type OrgPageMeta = {
  title: string;
  description: string;
  sourceUrl: string;
};

export type AnalysisPayload = {
  organizationName: string;
  ein: string | null;
  website: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  /** Additive: YouTube channel URL used for post/thumbnail extraction. */
  youtubeUrl?: string | null;
  mission: string | null;
  causeCategory: string | null;
  city: string | null;
  state: string | null;
  pageMeta: OrgPageMeta | null;
  images: SuggestedImage[];
  themes: string[];
  summary: string;
  provider: string;
};

export type CampaignIdeaRecord = {
  id: number;
  title: string;
  description: string;
  confidence: number;
  thumbnailUrl: string | null;
  suggestedGoal: number | null;
  suggestedMethods: AiCampaignMethod[];
  payload: Record<string, unknown> | null;
  sortOrder: number;
};

export type AnalysisSessionRecord = {
  id: number;
  sessionToken: string;
  nonprofitId: number | null;
  organizationName: string;
  ein: string | null;
  website: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  status: "pending" | "running" | "completed" | "failed";
  analysis: AnalysisPayload | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  ideas: CampaignIdeaRecord[];
};

type NonprofitRow = QueryResultRow & {
  id: number;
  organization_name: string;
  website: string | null;
  mission: string | null;
  cause_category: string | null;
  ein: string | null;
  city: string | null;
  state: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
};

type SessionRow = QueryResultRow & {
  id: number;
  session_token: string;
  nonprofit_id: number | null;
  organization_name: string;
  ein: string | null;
  website: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
  status: string;
  analysis_json: unknown;
  error_message: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type IdeaRow = QueryResultRow & {
  id: number;
  title: string;
  description: string | null;
  confidence: number;
  thumbnail_url: string | null;
  suggested_goal: string | number | null;
  suggested_methods: unknown;
  payload_json: unknown;
  sort_order: number;
};

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Fit a string into a VARCHAR(n) column for AI session persistence.
 * Inputs: raw string or null, max length. Outputs: trimmed ≤ max, or null.
 */
function fitVarchar(value: string | null | undefined, max: number): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function sessionExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_TTL_DAYS);
  return d;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseSuggestedGoal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const digits = value.replace(/[^0-9.]/g, "");
    if (!digits) return null;
    const n = Number.parseFloat(digits);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }
  return null;
}

function normalizeMethods(value: unknown): AiCampaignMethod[] {
  if (!Array.isArray(value)) return ["donations", "ambassador"];
  const out: AiCampaignMethod[] = [];
  for (const item of value) {
    const raw = trimStr(item);
    if (!raw) continue;
    const mapped =
      raw === "online_donations" || raw === "virtual_donations"
        ? "donations"
        : raw === "ambassador_fundraising"
          ? "ambassador"
          : raw === "dine_and_donate" || raw === "shop_and_donate" || raw === "service_giveback"
            ? "giveback"
            : raw === "guest_bartending_event"
              ? "guestBartending"
              : raw;
    if ((METHOD_VALUES as readonly string[]).includes(mapped) && !out.includes(mapped as AiCampaignMethod)) {
      out.push(mapped as AiCampaignMethod);
    }
  }
  return out.length ? out : ["donations", "ambassador"];
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return "";
}

async function fetchHtml(url: string): Promise<string | null> {
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
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const slice = buf.length > MAX_HTML_BYTES ? buf.subarray(0, MAX_HTML_BYTES) : buf;
    return slice.toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract public page title/description from OG / meta tags (no OAuth).
 */
export async function extractOrgPageMeta(websiteUrl: string): Promise<OrgPageMeta | null> {
  const normalized = normalizeWebsiteUrl(websiteUrl);
  if (!normalized) return null;
  const html = await fetchHtml(normalized);
  if (!html) return null;

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

  if (!title && !description) return null;
  return {
    title: title.slice(0, 300),
    description: description.slice(0, 1000),
    sourceUrl: normalized,
  };
}

async function loadNonprofit(id: number): Promise<NonprofitRow | null> {
  const { rows } = await pool.query<NonprofitRow>(
    `SELECT id, organization_name, website, mission, cause_category, ein, city, state,
            facebook_url, instagram_url, linkedin_url
       FROM nonprofits
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Resolve website + social URLs from request, local nonprofit row, known profiles,
 * website HTML discovery, and (when still missing) verified AI social guesses.
 */
export async function resolveAnalysisSources(input: AnalyzeOrgInput): Promise<{
  organizationName: string;
  ein: string | null;
  nonprofitId: number | null;
  website: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
  mission: string | null;
  causeCategory: string | null;
  city: string | null;
  state: string | null;
}> {
  const organizationName = trimStr(input.organizationName);
  let nonprofitId =
    typeof input.nonprofitId === "number" && Number.isFinite(input.nonprofitId) && input.nonprofitId > 0
      ? Math.floor(input.nonprofitId)
      : null;

  let website = normalizeWebsiteUrl(trimStr(input.website));
  let facebookUrl = normalizeFacebookUrl(trimStr(input.facebookUrl));
  let instagramRaw = trimStr(input.instagramUrl);
  let linkedinUrl = trimStr(input.linkedinUrl) || null;
  let youtubeUrl = normalizeYouTubeUrl(trimStr(input.youtubeUrl) || "") || null;
  let mission = trimStr(input.mission) || null;
  let causeCategory = trimStr(input.causeCategory) || null;
  let ein = trimStr(input.ein) || null;
  let city = trimStr(input.city) || null;
  let state = trimStr(input.state) || null;

  if (nonprofitId) {
    const row = await loadNonprofit(nonprofitId);
    if (row) {
      if (!website) website = normalizeWebsiteUrl(row.website || "");
      if (!facebookUrl) facebookUrl = normalizeFacebookUrl(row.facebook_url || "");
      if (!instagramRaw) instagramRaw = trimStr(row.instagram_url);
      if (!linkedinUrl) linkedinUrl = trimStr(row.linkedin_url) || null;
      if (!mission) mission = trimStr(row.mission) || null;
      if (!causeCategory) causeCategory = trimStr(row.cause_category) || null;
      if (!ein) ein = trimStr(row.ein) || null;
      if (!city) city = trimStr(row.city) || null;
      if (!state) state = trimStr(row.state) || null;
      if (!organizationName) {
        /* keep input name as required upstream */
      }
    } else {
      nonprofitId = null;
    }
  }

  const known =
    (website ? findKnownOrganizationProfile(website) : null) ||
    findKnownOrganizationByName(organizationName);
  if (known) {
    if (!website) website = normalizeWebsiteUrl(known.website || "");
    if (!mission) mission = trimStr(known.missionStatement) || null;
    if (!causeCategory) causeCategory = trimStr(known.causeCategory) || null;
    if (!ein) ein = trimStr(known.ein) || null;
    if (!city) city = trimStr(known.city) || null;
    if (!state) state = trimStr(known.state) || null;
    const social = Array.isArray(known.social) ? known.social : [];
    // Known profiles store channel labels (Facebook/Instagram), not URLs — keep as-is if URLs already set.
    if (!facebookUrl && social.includes("Facebook") && known.website) {
      /* no invented social URL */
    }
  }

  if (!website) {
    const guessed = await guessNonprofitWebsite({
      organizationName,
      ein,
      city,
      state,
    });
    if (guessed.website) website = normalizeWebsiteUrl(guessed.website);
  }

  // Pull social URLs from the public website when missing.
  if (website && (!facebookUrl || !instagramRaw || !linkedinUrl || !youtubeUrl)) {
    const discovered = await discoverSocialLinksFromWebsite(website);
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

  // No website (or site had no social links): AI-guess public profiles, verify HTTP.
  if (!facebookUrl || !instagramRaw || !linkedinUrl || !youtubeUrl) {
    const guessedSocial = await guessNonprofitSocialLinks({
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
    ? normalizeInstagramUrl(instagramRaw) || instagramRaw
    : null;

  return {
    organizationName,
    ein,
    nonprofitId,
    website: fitVarchar(website, 512),
    facebookUrl: fitVarchar(facebookUrl, 512),
    instagramUrl: fitVarchar(instagramUrl, 512),
    linkedinUrl: fitVarchar(linkedinUrl, 512),
    youtubeUrl: fitVarchar(youtubeUrl, 512),
    mission,
    causeCategory,
    city,
    state,
  };
}

type AiIdeaDraft = {
  title?: unknown;
  description?: unknown;
  confidence?: unknown;
  suggestedGoal?: unknown;
  suggestedMethods?: unknown;
  themes?: unknown;
  summary?: unknown;
};

/**
 * Run AI idea generation from resolved org context + scraped signals.
 */
export async function generateCampaignIdeasFromAnalysis(params: {
  organizationName: string;
  mission: string | null;
  causeCategory: string | null;
  city: string | null;
  state: string | null;
  pageMeta: OrgPageMeta | null;
  imageCount: number;
}): Promise<{
  summary: string;
  themes: string[];
  ideas: Array<{
    title: string;
    description: string;
    confidence: number;
    suggestedGoal: number | null;
    suggestedMethods: AiCampaignMethod[];
  }>;
  provider: string;
}> {
  if (aiProviderName() === "none") {
    throw new Error(
      "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
    );
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

  const raw = await aiChat({
    system,
    user: userParts.join("\n"),
    json: true,
    maxTokens: 2048,
    temperature: 0.45,
  });

  let parsed: {
    summary?: unknown;
    themes?: unknown;
    ideas?: AiIdeaDraft[];
  } = {};
  try {
    parsed = parseAiJson(raw);
  } catch {
    parsed = {};
  }

  const themes = Array.isArray(parsed.themes)
    ? parsed.themes
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 80))
        .slice(0, 8)
    : [];

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 500)
      : `Campaign ideas prepared for ${params.organizationName}.`;

  const ideasRaw = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  const ideas = ideasRaw
    .map((idea) => {
      const title = trimStr(idea.title).slice(0, 255);
      const description = trimStr(idea.description).slice(0, 1000);
      if (!title) return null;
      return {
        title,
        description: description || title,
        confidence: clampConfidence(idea.confidence),
        suggestedGoal: parseSuggestedGoal(idea.suggestedGoal),
        suggestedMethods: normalizeMethods(idea.suggestedMethods),
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

  if (!ideas.length) {
    ideas.push({
      title: `${params.organizationName} Community Fundraiser`,
      description:
        "A flexible community campaign with online donations and ambassador sharing — edit anytime.",
      confidence: 70,
      suggestedGoal: 10000,
      suggestedMethods: ["donations", "ambassador"],
    });
  }

  return {
    summary,
    themes,
    ideas,
    provider: aiProviderName(),
  };
}

function mapIdeaRow(row: IdeaRow): CampaignIdeaRecord {
  const goal =
    row.suggested_goal == null || row.suggested_goal === ""
      ? null
      : Number(row.suggested_goal);
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    confidence: clampConfidence(row.confidence),
    thumbnailUrl: row.thumbnail_url,
    suggestedGoal: Number.isFinite(goal as number) && (goal as number) > 0 ? Math.round(goal as number) : null,
    suggestedMethods: normalizeMethods(row.suggested_methods),
    payload:
      row.payload_json && typeof row.payload_json === "object"
        ? (row.payload_json as Record<string, unknown>)
        : null,
    sortOrder: Number(row.sort_order) || 0,
  };
}

function mapSessionRow(row: SessionRow, ideas: CampaignIdeaRecord[]): AnalysisSessionRecord {
  const status = row.status as AnalysisSessionRecord["status"];
  let analysis: AnalysisPayload | null = null;
  if (row.analysis_json && typeof row.analysis_json === "object") {
    analysis = row.analysis_json as AnalysisPayload;
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

async function loadIdeasForSession(sessionId: number): Promise<CampaignIdeaRecord[]> {
  const { rows } = await pool.query<IdeaRow>(
    `SELECT id, title, description, confidence, thumbnail_url, suggested_goal,
            suggested_methods, payload_json, sort_order
       FROM organization_ai_campaign_ideas
      WHERE analysis_session_id = $1
      ORDER BY sort_order ASC, confidence DESC, id ASC`,
    [sessionId],
  );
  return rows.map(mapIdeaRow);
}

/**
 * Load a session by public token (including ideas). Returns null if missing/expired.
 */
export async function getAnalysisSessionByToken(
  sessionToken: string,
): Promise<AnalysisSessionRecord | null> {
  const token = trimStr(sessionToken);
  if (!token) return null;

  const { rows } = await pool.query<SessionRow>(
    `SELECT id, session_token, nonprofit_id, organization_name, ein, website,
            facebook_url, instagram_url, linkedin_url, status, analysis_json,
            error_message, expires_at, created_at, updated_at
       FROM organization_ai_analysis_sessions
      WHERE session_token = $1
      LIMIT 1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
    return null;
  }

  const ideas = await loadIdeasForSession(row.id);
  return mapSessionRow(row, ideas);
}

/**
 * Compulsory backend Steps 3–4 then Step 5 idea generation.
 * Creates a resumable session row, scrapes public web signals, runs AI, stores ideas.
 */
export async function runOrganizationAiCampaignFlow(
  input: AnalyzeOrgInput,
): Promise<AnalysisSessionRecord> {
  const organizationName = trimStr(input.organizationName);
  if (!organizationName) {
    throw new Error("organizationName is required.");
  }

  const sources = await resolveAnalysisSources(input);
  const sessionToken = newSessionToken();
  const expiresAt = sessionExpiry();

  const insert = await pool.query<SessionRow>(
    `INSERT INTO organization_ai_analysis_sessions (
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
               error_message, expires_at, created_at, updated_at`,
    [
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
    ],
  );
  const session = insert.rows[0]!;

  try {
    const [pageMeta, images] = await Promise.all([
      sources.website ? extractOrgPageMeta(sources.website) : Promise.resolve(null),
      suggestSocialImages({
        websiteUrl: sources.website || undefined,
        facebookUrl: sources.facebookUrl || undefined,
        instagramHandle: sources.instagramUrl || undefined,
        linkedinUrl: sources.linkedinUrl || undefined,
        youtubeUrl: sources.youtubeUrl || undefined,
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

    const analysis: AnalysisPayload = {
      organizationName: sources.organizationName,
      ein: sources.ein,
      website: sources.website,
      facebookUrl: sources.facebookUrl,
      instagramUrl: sources.instagramUrl,
      linkedinUrl: sources.linkedinUrl,
      youtubeUrl: sources.youtubeUrl,
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

    await pool.query(
      `UPDATE organization_ai_analysis_sessions
          SET status = 'completed',
              analysis_json = $2::json,
              error_message = NULL,
              website = COALESCE(website, $3),
              facebook_url = COALESCE(facebook_url, $4),
              instagram_url = COALESCE(instagram_url, $5),
              linkedin_url = COALESCE(linkedin_url, $6)
        WHERE id = $1`,
      [
        session.id,
        JSON.stringify(analysis),
        sources.website,
        sources.facebookUrl,
        sources.instagramUrl,
        sources.linkedinUrl,
      ],
    );

    for (let i = 0; i < ai.ideas.length; i++) {
      const idea = ai.ideas[i]!;
      const thumbnail = images[i]?.url || images[0]?.url || null;
      await pool.query(
        `INSERT INTO organization_ai_campaign_ideas (
           analysis_session_id, title, description, confidence, thumbnail_url,
           suggested_goal, suggested_methods, payload_json, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8::json, $9)`,
        [
          session.id,
          idea.title,
          idea.description,
          idea.confidence,
          fitVarchar(thumbnail, 512),
          idea.suggestedGoal,
          JSON.stringify(idea.suggestedMethods),
          JSON.stringify({
            themes: ai.themes,
            summary: ai.summary,
          }),
          i,
        ],
      );
    }

    const loaded = await getAnalysisSessionByToken(sessionToken);
    if (!loaded) {
      throw new Error("Analysis completed but session could not be reloaded.");
    }
    return loaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed.";
    await pool.query(
      `UPDATE organization_ai_analysis_sessions
          SET status = 'failed', error_message = $2
        WHERE id = $1`,
      [session.id, message.slice(0, 2000)],
    );
    throw err instanceof Error ? err : new Error(message);
  }
}

/**
 * Purpose: Turn a short organizer purpose phrase into a campaign title + story
 * for the AI-flow "Start from scratch" path (site create campaign).
 * Does not write to the database — caller applies result to browser draft state.
 *
 * Inputs: purpose + optional org/mission/methods/goal context.
 * Outputs: { title, story, purpose, suggestedGoal?, provider }
 */
export async function draftCampaignFromPurpose(params: {
  purpose: string;
  organizationName: string;
  mission?: string | null;
  causeCategory?: string | null;
  website?: string | null;
  methods?: string[];
  goal?: string | number | null;
}): Promise<{
  title: string;
  story: string;
  purpose: string;
  suggestedGoal: number | null;
  provider: string;
}> {
  if (aiProviderName() === "none") {
    throw new Error(
      "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
    );
  }

  const purpose = trimStr(params.purpose).slice(0, 2000);
  if (!purpose) {
    throw new Error("Tell us what you're raising money for.");
  }

  const organizationName =
    trimStr(params.organizationName).slice(0, 255) || "Your organization";
  const mission = trimStr(params.mission) || null;
  const causeCategory = trimStr(params.causeCategory) || null;
  const website = trimStr(params.website) || null;
  const methods = Array.isArray(params.methods)
    ? params.methods.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
    : [];
  const goalRaw =
    params.goal != null && String(params.goal).trim() !== ""
      ? String(params.goal).trim()
      : "";
  const needsSuggestedGoal = !goalRaw;

  const system = [
    "You are an expert nonprofit fundraising campaign writer for the ForkUp platform.",
    "Given a short purpose from a nonprofit organizer, prepare a campaign draft they will review and edit.",
    "Write in the organization's authentic voice. Be specific and truthful — never invent facts, names, dates, or past results.",
    "Prioritize emotional connection, clarity, impact, and a clear reason to participate.",
    "Guidelines:",
    "- title: a compelling campaign title, max ~70 characters, no quotation marks.",
    "- story: 120-220 words, warm and concrete, explaining why the cause matters and how support helps. No generic clichés or invented statistics.",
    "- purpose: a single short sentence summarizing the campaign goal.",
    needsSuggestedGoal
      ? "- suggestedGoal: a realistic whole-dollar USD fundraising target (integer, no $ or commas) based on purpose and methods. Typical community campaigns: 2500–25000. Recommendation only — do not put the dollar amount in the story as a fact."
      : "- Do not invent a fundraising goal amount; the organizer already provided one.",
    needsSuggestedGoal
      ? 'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string, "suggestedGoal": number}.'
      : 'Return ONLY valid minified JSON with exactly these keys: {"title": string, "story": string, "purpose": string}.',
    "Do not include markdown, code fences, preamble, or commentary.",
  ].join("\n");

  const userParts = [
    `What they're raising money for: ${purpose}`,
    `Organization: ${organizationName}`,
    mission ? `Mission: ${mission}` : "",
    causeCategory ? `Cause category: ${causeCategory}` : "",
    website ? `Organization website: ${website}` : "",
    goalRaw
      ? `Fundraising goal: ${goalRaw}`
      : "Fundraising goal: not provided — suggest a realistic target.",
    methods.length ? `Fundraising methods: ${methods.join(", ")}` : "",
  ].filter(Boolean);

  const raw = await aiChat({
    system,
    user: userParts.join("\n"),
    json: true,
    maxTokens: 2048,
    temperature: 0.4,
  });

  let draft: {
    title?: unknown;
    story?: unknown;
    purpose?: unknown;
    suggestedGoal?: unknown;
  } = {};
  try {
    draft = parseAiJson(raw);
  } catch {
    draft = { story: raw };
  }

  const title =
    trimStr(draft.title).slice(0, 120) || `${organizationName} Fundraiser`;
  const story = trimStr(draft.story) || purpose;
  const purposeOut = trimStr(draft.purpose) || purpose;
  const suggestedGoal = needsSuggestedGoal
    ? parseSuggestedGoal(draft.suggestedGoal)
    : null;

  return {
    title,
    story,
    purpose: purposeOut,
    suggestedGoal,
    provider: aiProviderName(),
  };
}
