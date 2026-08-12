import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Router } from "express";
import { isS3Enabled, uploadImageToS3 } from "../lib/s3";

export const uploadsRouter = Router();

/** Maps a client-supplied upload kind to an S3 key folder / local subdir. */
const KIND_PREFIX: Record<string, string> = {
  cover: "covers",
  logo: "logos",
};

/** Short content hash so identical bytes reuse one on-disk file. */
function imageContentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/**
 * Writes an image buffer under `uploads/<prefix>/` and returns a public
 * `/uploads/<prefix>/<filename>` path (served by express.static in mount.ts).
 * Used when S3 is not configured so local/dev cover uploads still persist.
 * Same bytes → same path (no duplicate files).
 */
function saveImageToDisk(buffer: Buffer, mimeType: string, prefix: string): string {
  const dir = path.join(process.cwd(), "uploads", prefix);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mimeType.includes("png")
    ? "png"
    : mimeType.includes("webp")
      ? "webp"
      : "jpg";
  const filename = `${prefix.slice(0, -1) || "img"}-${imageContentHash(buffer)}.${ext}`;
  const filepath = path.join(dir, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, buffer);
  }
  return `/uploads/${prefix}/${filename}`;
}

/**
 * POST /api/uploads/image
 * Request: { imageBase64: string, imageMimeType?: string, kind?: "cover" | "logo" }
 * Response: { url: string } — `s3://…` when S3 is configured, else `/uploads/…` disk path.
 */
uploadsRouter.post("/image", async (req, res) => {
  try {
    const { imageBase64, imageMimeType, kind } = req.body as Record<string, unknown>;

    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "Image is required" });
      return;
    }

    const mime = typeof imageMimeType === "string" && imageMimeType ? imageMimeType : "image/jpeg";
    const prefix = (typeof kind === "string" && KIND_PREFIX[kind]) || "uploads";
    const data = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(data, "base64");

    if (isS3Enabled()) {
      try {
        const url = await uploadImageToS3(buffer, mime, prefix);
        res.status(201).json({ url });
        return;
      } catch (err) {
        // Local/dev often has S3_BUCKET set with invalid credentials — fall back to disk.
        console.warn("S3 upload failed; saving image to local disk instead:", err);
      }
    }

    const url = saveImageToDisk(buffer, mime, prefix);
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upload image" });
  }
});
