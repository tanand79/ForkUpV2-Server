"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadsRouter = void 0;
const express_1 = require("express");
const s3_1 = require("../lib/s3");
exports.uploadsRouter = (0, express_1.Router)();
const KIND_PREFIX = {
    cover: "covers",
    logo: "logos",
};
exports.uploadsRouter.post("/image", async (req, res) => {
    try {
        const { imageBase64, imageMimeType, kind } = req.body;
        if (!imageBase64 || typeof imageBase64 !== "string") {
            res.status(400).json({ error: "Image is required" });
            return;
        }
        if (!(0, s3_1.isS3Enabled)()) {
            res.status(503).json({ error: "Image uploads are not configured" });
            return;
        }
        const mime = typeof imageMimeType === "string" && imageMimeType ? imageMimeType : "image/jpeg";
        const prefix = (typeof kind === "string" && KIND_PREFIX[kind]) || "uploads";
        const data = imageBase64.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(data, "base64");
        const url = await (0, s3_1.uploadImageToS3)(buffer, mime, prefix);
        res.status(201).json({ url });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to upload image" });
    }
});
//# sourceMappingURL=uploads.js.map