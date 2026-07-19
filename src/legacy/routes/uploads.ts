import { Router } from "express";
import { isS3Enabled, uploadImageToS3 } from "../lib/s3";

export const uploadsRouter = Router();

/** Maps a client-supplied upload kind to an S3 key folder. */
const KIND_PREFIX: Record<string, string> = {
  cover: "covers",
  logo: "logos",
};

/**
 * Uploads a base64-encoded image to S3 and returns its `s3://<key>` reference.
 * The caller stores that reference (e.g. as a campaign cover); the read paths
 * turn it into a presigned https URL. Returns 503 when S3 is not configured.
 */
uploadsRouter.post("/image", async (req, res) => {
  try {
    const { imageBase64, imageMimeType, kind } = req.body as Record<string, unknown>;

    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "Image is required" });
      return;
    }
    if (!isS3Enabled()) {
      res.status(503).json({ error: "Image uploads are not configured" });
      return;
    }

    const mime = typeof imageMimeType === "string" && imageMimeType ? imageMimeType : "image/jpeg";
    const prefix = (typeof kind === "string" && KIND_PREFIX[kind]) || "uploads";
    const data = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(data, "base64");

    const url = await uploadImageToS3(buffer, mime, prefix);
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upload image" });
  }
});
