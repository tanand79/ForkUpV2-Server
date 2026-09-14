"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeJoinDoorType = normalizeJoinDoorType;
function normalizeJoinDoorType(raw) {
    if (raw === "restaurant" || raw === "local")
        return raw;
    if (typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        if (v === "restaurant" || v === "local")
            return v;
    }
    return null;
}
//# sourceMappingURL=join-door-type.js.map