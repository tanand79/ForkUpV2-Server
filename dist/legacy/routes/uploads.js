"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadsRouter = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const express_1 = require("express");
const s3_1 = require("../lib/s3");
exports.uploadsRouter = (0, express_1.Router)();
const KIND_PREFIX = {
    cover: "covers",
    logo: "logos",
};
function saveImageToDisk(buffer, mimeType, prefix) {
    const dir = path_1.default.join(process.cwd(), "uploads", prefix);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const ext = mimeType.includes("png")
        ? "png"
        : mimeType.includes("webp")
            ? "webp"
            : "jpg";
    const filename = `${prefix.slice(0, -1) || "img"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs_1.default.writeFileSync(path_1.default.join(dir, filename), buffer);
    return `/uploads/${prefix}/${filename}`;
}
exports.uploadsRouter.post("/image", async (req, res) => {
    try {
        const { imageBase64, imageMimeType, kind } = req.body;
        if (!imageBase64 || typeof imageBase64 !== "string") {
            res.status(400).json({ error: "Image is required" });
            return;
        }
        const mime = typeof imageMimeType === "string" && imageMimeType ? imageMimeType : "image/jpeg";
        const prefix = (typeof kind === "string" && KIND_PREFIX[kind]) || "uploads";
        const data = imageBase64.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(data, "base64");
        if ((0, s3_1.isS3Enabled)()) {
            try {
                const url = await (0, s3_1.uploadImageToS3)(buffer, mime, prefix);
                res.status(201).json({ url });
                return;
            }
            catch (err) {
                console.warn("S3 upload failed; saving image to local disk instead:", err);
            }
        }
        const url = saveImageToDisk(buffer, mime, prefix);
        res.status(201).json({ url });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to upload image" });
    }
});
//# sourceMappingURL=uploads.js.map