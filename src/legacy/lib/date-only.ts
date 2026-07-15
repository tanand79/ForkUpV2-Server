const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})/;

/** Normalize a calendar date to YYYY-MM-DD without UTC timezone drift. */
export function toDateOnlyString(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const match = DATE_ONLY_RE.exec(value.trim());
    return match ? match[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** Subtract whole calendar days from a YYYY-MM-DD string. */
export function subtractCalendarDays(dateStr: string, days: number): string {
  const base = toDateOnlyString(dateStr);
  if (!base) return dateStr;
  return addCalendarDays(base, -days);
}

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addCalendarDays(dateStr: string, days: number): string {
  const base = toDateOnlyString(dateStr);
  if (!base) return dateStr;
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toDateOnlyString(dt) ?? dateStr;
}

/**
 * Parse human-entered dates (ISO, "June 15", "june15", "6/15/2026") to YYYY-MM-DD.
 */
export function parseFlexibleDateInput(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;

  const iso = toDateOnlyString(raw);
  if (iso) return iso;

  const trimmed = raw.trim();

  const monthDayYear = trimmed.match(/^([a-zA-Z]+)\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
  if (monthDayYear) {
    const year = monthDayYear[3] ?? String(new Date().getFullYear());
    const attempt = new Date(`${monthDayYear[1]} ${monthDayYear[2]}, ${year}`);
    if (!Number.isNaN(attempt.getTime())) return toDateOnlyString(attempt);
  }

  const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashDate) {
    const year =
      slashDate[3]?.length === 2
        ? 2000 + Number(slashDate[3])
        : slashDate[3]
          ? Number(slashDate[3])
          : new Date().getFullYear();
    const attempt = new Date(year, Number(slashDate[1]) - 1, Number(slashDate[2]));
    if (!Number.isNaN(attempt.getTime())) return toDateOnlyString(attempt);
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return toDateOnlyString(parsed);

  return null;
}
