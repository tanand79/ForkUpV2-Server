"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseChangeRequestMessage = parseChangeRequestMessage;
exports.shiftCampaignDates = shiftCampaignDates;
const date_only_1 = require("./date-only");
function parseChangeRequestMessage(raw) {
    if (!raw?.trim()) {
        return { preferredDate: null, preferredGiveback: null, message: null };
    }
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    let preferredDate = null;
    let preferredGiveback = null;
    const messageLines = [];
    for (const line of lines) {
        const dateMatch = line.match(/^preferred\s+date(?:\/time)?\s*:\s*(.+)$/i);
        if (dateMatch) {
            preferredDate = (0, date_only_1.parseFlexibleDateInput)(dateMatch[1].trim());
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
function shiftCampaignDates(newStart, currentStart, currentEnd) {
    const start = (0, date_only_1.toDateOnlyString)(newStart);
    if (!start)
        return { startDate: newStart, endDate: currentEnd ?? null };
    const prevStart = (0, date_only_1.toDateOnlyString)(currentStart);
    const prevEnd = (0, date_only_1.toDateOnlyString)(currentEnd);
    if (prevStart && prevEnd) {
        const [sy, sm, sd] = prevStart.split("-").map(Number);
        const [ey, em, ed] = prevEnd.split("-").map(Number);
        const startDt = new Date(sy, sm - 1, sd);
        const endDt = new Date(ey, em - 1, ed);
        const durationDays = Math.max(0, Math.round((endDt.getTime() - startDt.getTime()) / (24 * 60 * 60 * 1000)));
        return { startDate: start, endDate: (0, date_only_1.addCalendarDays)(start, durationDays) };
    }
    if (prevEnd) {
        const end = (0, date_only_1.toDateOnlyString)(prevEnd);
        if (end && end < start) {
            return { startDate: start, endDate: start };
        }
        return { startDate: start, endDate: end };
    }
    return { startDate: start, endDate: null };
}
//# sourceMappingURL=parse-change-request.js.map