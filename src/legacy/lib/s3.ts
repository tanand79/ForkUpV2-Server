import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

/**
 * S3 image storage for receipts (private) and campaign cover images.
 *
 * Stored DB convention: an S3 object is referenced as `s3://<key>` (a short,
 * stable string that fits VARCHAR(512)). Presigned https URLs are generated at
 * read time and never stored. Any value that is not an `s3://` reference
 * (legacy `/uploads/...` disk paths, preset filenames, or `http(s)` URLs) is
 * passed through untouched so existing data keeps working.
 */

const S3_PREFIX = "s3://";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: config.s3.region });
  }
  return s3Client;
}

/** True when a bucket is configured; otherwise callers fall back to disk. */
export function isS3Enabled(): boolean {
  return Boolean(config.s3.bucket);
}

/** Whether a stored value is an S3 reference produced by {@link uploadImageToS3}. */
export function isS3Ref(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(S3_PREFIX);
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Uploads an image buffer to S3 under `<prefix>/` and returns its `s3://<key>`
 * reference for storage. Throws if S3 is not configured.
 */
export async function uploadImageToS3(
  buffer: Buffer,
  mimeType: string,
  prefix: string,
): Promise<string> {
  if (!isS3Enabled()) {
    throw new Error("S3 is not configured (set S3_BUCKET)");
  }
  const ext = extensionForMime(mimeType);
  const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return `${S3_PREFIX}${key}`;
}

/** Generates a short-lived presigned GET URL for an S3 object key. */
export async function presignGetUrl(key: string): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: config.s3.presignTtlSeconds },
  );
}

/**
 * Resolves a stored image value into a browser-loadable URL. `s3://` references
 * become presigned https URLs; everything else is returned unchanged. Never
 * throws — on presign failure the original value is returned.
 */
export async function resolveStoredImageUrl<T extends string | null | undefined>(
  stored: T,
): Promise<T> {
  if (!isS3Ref(stored)) return stored;
  const key = (stored as string).slice(S3_PREFIX.length);
  try {
    return (await presignGetUrl(key)) as T;
  } catch (err) {
    console.error("Failed to presign S3 object:", err);
    return stored;
  }
}
