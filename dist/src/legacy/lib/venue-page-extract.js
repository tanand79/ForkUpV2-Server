"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseHoursFromText = parseHoursFromText;
exports.extractVenueCopyFromPage = extractVenueCopyFromPage;
const ai_chat_1 = require("./ai-chat");
const DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const DAY_ALIASES = {
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
function emptyHours() {
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
function cleanAbout(raw) {
    if (typeof raw !== "string")
        return "";
    const text = raw
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line &&
        !/not provided|skip to main|toggle navigation|recaptcha|close this site/i.test(line))
        .join("\n\n")
        .trim();
    return text.slice(0, 2000);
}
function cleanDay(raw) {
    if (typeof raw !== "string")
        return "-";
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text || /^(-|—|–|closed|n\/a|none|unknown|not listed)$/i.test(text))
        return "-";
    return text.slice(0, 80);
}
function cleanWindow(raw) {
    if (typeof raw !== "string")
        return "";
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text || /not provided|unknown|n\/a/i.test(text))
        return "";
    return text.slice(0, 80);
}
function dayIndex(day) {
    return DAYS.indexOf(day);
}
function expandDayRange(from, to) {
    const a = dayIndex(from);
    const b = dayIndex(to);
    if (a < 0 || b < 0)
        return [from];
    if (a <= b)
        return DAYS.slice(a, b + 1);
    return [...DAYS.slice(a), ...DAYS.slice(0, b + 1)];
}
function parseDayToken(raw) {
    return DAY_ALIASES[raw.trim().toLowerCase()] ?? null;
}
function normalizeMealLabel(detail) {
    const d = detail.replace(/\s+/g, " ").trim();
    if (/^closed\b/i.test(d))
        return "-";
    const hasLunch = /\blunch\b/i.test(d);
    const hasDinner = /\bdinner\b/i.test(d);
    const hasBrunch = /\bbrunch\b/i.test(d);
    if (hasLunch && hasDinner)
        return "Lunch and Dinner";
    if (hasBrunch && hasDinner)
        return "Brunch and Dinner";
    if (hasLunch && hasBrunch)
        return "Lunch/Brunch";
    if (hasBrunch)
        return "Brunch";
    if (hasLunch)
        return d.length <= 40 ? d : "Lunch";
    if (hasDinner)
        return d.length <= 40 ? d : "Dinner";
    return d.slice(0, 60) || "-";
}
function mergeDayLabel(existing, next) {
    if (!next || next === "-")
        return existing || "-";
    if (!existing || existing === "-")
        return next;
    if (existing.toLowerCase().includes(next.toLowerCase()))
        return existing;
    if (next.toLowerCase().includes(existing.toLowerCase()))
        return next;
    const merged = `${existing}; ${next}`;
    return normalizeMealLabel(merged);
}
function parseHoursFromText(raw) {
    const hours = emptyHours();
    if (!raw.trim())
        return hours;
    const text = raw
        .replace(/\u00a0/g, " ")
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    const rangeRe = /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-\s*(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+([^.;\n]+?)(?=(?:\s+(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:\s*-|\s+-)|$))/gi;
    let match;
    while ((match = rangeRe.exec(text))) {
        const from = parseDayToken(match[1]);
        const to = parseDayToken(match[2]);
        const label = normalizeMealLabel(match[3] || "");
        if (!from || !to || !label || label === "-")
            continue;
        for (const day of expandDayRange(from, to)) {
            hours[day] = mergeDayLabel(hours[day], label);
        }
    }
    const singleRe = /\b(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-\s*([^.;\n]+?)(?=(?:\s+(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*-)|$)/gi;
    while ((match = singleRe.exec(text))) {
        const day = parseDayToken(match[1]);
        const detail = (match[2] || "").trim();
        if (!day)
            continue;
        if (parseDayToken(detail.split(/\s+/)[0] || ""))
            continue;
        const label = normalizeMealLabel(detail);
        hours[day] = mergeDayLabel(hours[day], label);
    }
    return hours;
}
function hasOpenDay(hours) {
    return DAYS.some((d) => hours[d] !== "-");
}
function preferHours(primary, secondary) {
    return hasOpenDay(primary) ? primary : secondary;
}
async function extractVenueCopyFromPage(pageText, hints) {
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
    if ((0, ai_chat_1.aiProviderName)() !== "none" && text.length >= 40) {
        try {
            const content = await (0, ai_chat_1.aiChat)({
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
            const parsed = (0, ai_chat_1.parseAiJson)(content);
            const hoursRaw = parsed.hours && typeof parsed.hours === "object"
                ? parsed.hours
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
            if (!about)
                about = cleanAbout(parsed.about);
            eligibleWindow = cleanWindow(parsed.eligibleWindow);
        }
        catch (err) {
            console.warn("extractVenueCopyFromPage AI enrich failed:", err instanceof Error ? err.message : err);
        }
    }
    if (!about && !hasOpenDay(discountHours) && !eligibleWindow)
        return null;
    return {
        about,
        discountHours,
        eligibleWindow,
    };
}
//# sourceMappingURL=venue-page-extract.js.map