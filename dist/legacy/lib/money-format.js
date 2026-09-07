"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatMoneyUSD = formatMoneyUSD;
exports.formatMoneyNumber = formatMoneyNumber;
function formatMoneyUSD(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n))
        return "$0.00";
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}
function formatMoneyNumber(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n))
        return "0.00";
    return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}
//# sourceMappingURL=money-format.js.map