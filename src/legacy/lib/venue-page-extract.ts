/**
 * Pull venue about-text and weekday hours from scraped public page text.
 * Prefer deterministic parse from the site HTML/text; AI is optional enrichment.
 * Does not invent facts that are absent from the page.
 */
import { aiChat, aiProviderName, parseAiJson } from "./ai-chat";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type VenueWeekday = (typeof DAYS)[number];

export type VenuePageCopy = {
  about: string;
  discountHours: Record<VenueWeekday, string>;
  eligibleWindow: string;
};

const DAY_ALIASES: Record<string, VenueWeekday> = {
  mon: "Monday",
  monday: "Monday",
  tue: "Tuesday",
  tues: "Tuesday",
  tuesday: "Tuesday",
  wed: "Wednesday",
  wednesday: "Wednesday",
  thu: "Thursday",
  thur: "Thursday",
  thurs: "Thursday",
  thursday: "Thursday",
  fri: "Friday",
  friday: "Friday",
  sat: "Saturday",
  saturday: "Saturday",
  sun: "Sunday",
  sunday: "Sunday",
};

function emptyHours(): Record<VenueWeekday, string> {
  return {
    Monday: "-",
    Tuesday: "-",
    Wednesday: "-",
    Thursday: "-",
    Friday: "-",
    Saturday: "-",
    Sunday: "-",
  };
}

function cleanAbout(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/not provided|skip to main|toggle navigation|recaptcha|close this site/i.test(
          line,
        ),
    )
    .join("\n\n")
    .trim();
  return text.slice(0, 2000);
}

function cleanDay(raw: unknown): string {
  if (typeof raw !== "string") return "-";
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text || /^(-|—|–|closed|n\/a|none|unknown|not listed)$/i.test(text)) return "-";
  return text.slice(0, 80);
}

function cleanWindow(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text || /not provided|unknown|n\/a/i.test(text)) return "";
  return text.slice(0, 80);
}

function dayIndex(day: VenueWeekday): number {
  return DAYS.indexOf(day);
}

function expandDayRange(from: VenueWeekday, to: VenueWeekday): VenueWeekday[] {
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (a < 0 || b < 0) return [from];
  if (a <= b) return DAYS.slice(a, b + 1) as VenueWeekday[];
  return [...DAYS.slice(a), ...DAYS.slice(0, b + 1)] as VenueWeekday[];
}

function parseDayToken(raw: string): VenueWeekday | null {
  return DAY_ALIASES[raw.trim().toLowerCase()] ?? null;
}

function normalizeMealLabel(detail: string): string {
  const d = detail.replace(/\s+/g, " ").trim();
  if (/^closed\b/i.test(d)) return "-";
  const hasLunch = /\blunch\b/i.test(d);
  const hasDinner = /\bdinner\b/i.test(d);
  const hasBrunch = /\bbrunch\b/i.test(d);
  if (hasLunch && hasDinner) return "Lunch and Dinner";
  if (hasBrunch && hasDinner) return "Brunch and Dinner";
  if (hasLunch && hasBrunch) return "Lunch/Brunch";
  if (hasBrunch) return "Brunch";
  if (hasLunch) return d.length <= 40 ? d : "Lunch";
  if (hasDinner) return d.length <= 40 ? d : "Dinner";
  return d.slice(0, 60) || "-";
}

function mergeDayLabel(existing: string, next: string): string {
  if (!next || next === "-") return existing || "-";
  if (!existing || existing === "-") return next;
  if (existing.toLowerCase().includes(next.toLowerCase())) return existing;
  if (next.toLowerCase().includes(existing.toLowerCase())) return next;
  const merged = `${existing}; ${next}`;
  return normalizeMealLabel(merged);
}

/**
 * Parse weekday hours from site text (ranges like "Tuesday - Friday Lunch 11-3:30").
 */
export function parseHoursFromText(raw: string): Record<VenueWeekday, string> {
  const hours = emptyHours();
  if (!raw.trim()) return hours;

  const text = raw
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const rangeRe =
    /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-\s*(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+([^.;\n]+?)(?=(?:\s+(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:\s*-|\s+-)|$))/gi;

  let match: RegExpExecArray | null;
  while ((match = rangeRe.exec(text))) {
    const from = parseDayToken(match[1]);
    const to = parseDayToken(match[2]);
    const label = normalizeMealLabel(match[3] || "");
    if (!from || !to || !label || label === "-") continue;
    for (const day of expandDayRange(from, to)) {
      hours[day] = mergeDayLabel(hours[day], label);
    }
  }

  const singleRe =
    /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-\s*([^.;\n]+?)(?=(?:\s+(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-)|$)/gi;

  while ((match = singleRe.exec(text))) {
    const day = parseDayToken(match[1]);
    const detail = (match[2] || "").trim();
    if (!day) continue;
    // Skip if this was already captured as the start of a range ("Tuesday - Friday ...")
    if (parseDayToken(detail.split(/\s+/)[0] || "")) continue;
    const label = normalizeMealLabel(detail);
    hours[day] = mergeDayLabel(hours[day], label);
  }

  return hours;
}

function hasOpenDay(hours: Record<VenueWeekday, string>): boolean {
  return DAYS.some((d) => hours[d] !== "-");
}

function preferHours(
  primary: Record<VenueWeekday, string>,
  secondary: Record<VenueWeekday, string>,
): Record<VenueWeekday, string> {
  return hasOpenDay(primary) ? primary : secondary;
}

/**
 * Read about + hours from site text / scrape hints.
 * Works without AI; AI only fills gaps when configured.
 */
export async function extractVenueCopyFromPage(
  pageText: string,
  hints?: { aboutHint?: string; hoursText?: string },
): Promise<VenuePageCopy | null> {
  const text = pageText.trim();
  const aboutHint = cleanAbout(hints?.aboutHint || "");
  const hoursSource = (hints?.hoursText || text).trim();
  const parsedHours = parseHoursFromText(hoursSource);
  const fallbackHours = parseHoursFromText(text);
  let discountHours = preferHours(parsedHours, fallbackHours);
  let about = aboutHint;
  let eligibleWindow = "";

  if (!about && text.length >= 80) {
    const paras = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 50)
      .filter((p) => !/skip to main|toggle navigation|order online|gift cards/i.test(p))
      .slice(0, 4);
    about = cleanAbout(paras.join("\n\n"));
  }

  if (aiProviderName() !== "none" && text.length >= 40) {
    try {
      const content = await aiChat({
        system: [
          "You extract a public venue profile from PAGE TEXT only.",
          "Do not invent a story, hours, or times that are not in the text.",
          "about: 2–4 short paragraphs from the site's own description, separated by blank lines. Empty string if the page has no description.",
          "hours: one label per weekday. Use the site's own words (Lunch and Dinner, Brunch, 11am–9pm). Use \"-\" when that day is closed or not mentioned.",
          "eligibleWindow: a single time range only if the page states one (example: 6:00pm–9:00pm). Otherwise empty string.",
          "Return ONLY JSON with keys: about, hours, eligibleWindow.",
          "hours must be an object with Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.",
        ].join("\n"),
        user: `PAGE TEXT:\n${(hoursSource || text).slice(0, 6000)}`,
        json: true,
        maxTokens: 1200,
        temperature: 0.1,
      });
      const parsed = parseAiJson(content);
      const hoursRaw =
        parsed.hours && typeof parsed.hours === "object"
          ? (parsed.hours as Record<string, unknown>)
          : {};
      const aiHours = {
        Monday: cleanDay(hoursRaw.Monday),
        Tuesday: cleanDay(hoursRaw.Tuesday),
        Wednesday: cleanDay(hoursRaw.Wednesday),
        Thursday: cleanDay(hoursRaw.Thursday),
        Friday: cleanDay(hoursRaw.Friday),
        Saturday: cleanDay(hoursRaw.Saturday),
        Sunday: cleanDay(hoursRaw.Sunday),
      };
      discountHours = preferHours(discountHours, aiHours);
      if (!about) about = cleanAbout(parsed.about);
      eligibleWindow = cleanWindow(parsed.eligibleWindow);
    } catch (err) {
      console.warn(
        "extractVenueCopyFromPage AI enrich failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!about && !hasOpenDay(discountHours) && !eligibleWindow) return null;

  return {
    about,
    discountHours,
    eligibleWindow,
  };
}
