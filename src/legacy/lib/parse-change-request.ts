import { addCalendarDays, parseFlexibleDateInput, toDateOnlyString } from "./date-only";

export type ParsedChangeRequest = {
  preferredDate: string | null;
  preferredGiveback: number | null;
  message: string | null;
};

/** Parse combined change-request text from business_acceptances.change_request_message. */
export function parseChangeRequestMessage(
  raw: string | null | undefined,
): ParsedChangeRequest {
  if (!raw?.trim()) {
    return { preferredDate: null, preferredGiveback: null, message: null };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let preferredDate: string | null = null;
  let preferredGiveback: number | null = null;
  const messageLines: string[] = [];

  for (const line of lines) {
    const dateMatch = line.match(/^preferred\s+date(?:\/time)?\s*:\s*(.+)$/i);
    if (dateMatch) {
      preferredDate = parseFlexibleDateInput(dateMatch[1].trim());
      continue;
    }
    const givebackMatch = line.match(/^preferred\s+giveback\s*:\s*(\d+(?:\.\d+)?)\s*%?\s*$/i);
    if (givebackMatch) {
      preferredGiveback = Number(givebackMatch[1]);
      continue;
    }
    messageLines.push(line);
  }

  return {
    preferredDate,
    preferredGiveback,
    message: messageLines.length > 0 ? messageLines.join("\n") : null,
  };
}

/** Apply a new start date while preserving campaign length when possible. */
export function shiftCampaignDates(
  newStart: string,
  currentStart: string | null | undefined,
  currentEnd: string | null | undefined,
): { startDate: string; endDate: string | null } {
  const start = toDateOnlyString(newStart);
  if (!start) return { startDate: newStart, endDate: currentEnd ?? null };

  const prevStart = toDateOnlyString(currentStart);
  const prevEnd = toDateOnlyString(currentEnd);

  if (prevStart && prevEnd) {
    const [sy, sm, sd] = prevStart.split("-").map(Number);
    const [ey, em, ed] = prevEnd.split("-").map(Number);
    const startDt = new Date(sy, sm - 1, sd);
    const endDt = new Date(ey, em - 1, ed);
    const durationDays = Math.max(
      0,
      Math.round((endDt.getTime() - startDt.getTime()) / (24 * 60 * 60 * 1000)),
    );
    return { startDate: start, endDate: addCalendarDays(start, durationDays) };
  }

  if (prevEnd) {
    const end = toDateOnlyString(prevEnd);
    if (end && end < start) {
      return { startDate: start, endDate: start };
    }
    return { startDate: start, endDate: end };
  }

  return { startDate: start, endDate: null };
}
