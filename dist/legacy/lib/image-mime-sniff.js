"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sniffImageMediaType = sniffImageMediaType;
exports.normalizeImageMediaType = normalizeImageMediaType;
function sniffImageMediaType(buffer) {
    if (buffer.length >= 8) {
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            return "image/png";
        }
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
            return "image/jpeg";
        }
        if (buffer[0] === 0x47 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x38) {
            return "image/gif";
        }
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50) {
            return "image/webp";
        }
    }
    return "image/jpeg";
}
function normalizeImageMediaType(buffer, declaredMime) {
    const sniffed = sniffImageMediaType(buffer);
    const declared = String(declaredMime ?? "").trim().toLowerCase();
    const declaredBase = declared.split(";")[0]?.trim() ?? "";
    if (!declaredBase || declaredBase === sniffed)
        return sniffed;
    return sniffed;
}
//# sourceMappingURL=image-mime-sniff.js.map