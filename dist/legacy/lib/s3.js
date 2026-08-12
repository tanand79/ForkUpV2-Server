"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isS3Enabled = isS3Enabled;
exports.isS3Ref = isS3Ref;
exports.uploadImageToS3 = uploadImageToS3;
exports.presignGetUrl = presignGetUrl;
exports.resolveStoredImageUrl = resolveStoredImageUrl;
const crypto_1 = __importDefault(require("crypto"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const config_1 = require("../config");
const S3_PREFIX = "s3://";
let s3Client = null;
function getS3Client() {
    if (!s3Client) {
        s3Client = new client_s3_1.S3Client({ region: config_1.config.s3.region });
    }
    return s3Client;
}
function isS3Enabled() {
    return Boolean(config_1.config.s3.bucket);
}
function isS3Ref(stored) {
    return typeof stored === "string" && stored.startsWith(S3_PREFIX);
}
function extensionForMime(mimeType) {
    if (mimeType.includes("png"))
        return "png";
    if (mimeType.includes("webp"))
        return "webp";
    if (mimeType.includes("gif"))
        return "gif";
    return "jpg";
}
async function uploadImageToS3(buffer, mimeType, prefix) {
    if (!isS3Enabled()) {
        throw new Error("S3 is not configured (set S3_BUCKET)");
    }
    const ext = extensionForMime(mimeType);
    const hash = crypto_1.default.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const key = `${prefix}/${hash}.${ext}`;
    const client = getS3Client();
    const bucket = config_1.config.s3.bucket;
    try {
        await client.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return `${S3_PREFIX}${key}`;
    }
    catch (err) {
        const status = err && typeof err === "object" && "$metadata" in err
            ? err.$metadata
                ?.httpStatusCode
            : undefined;
        const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
        if (status !== 404 && name !== "NotFound" && name !== "NoSuchKey") {
            throw err;
        }
    }
    await client.send(new client_s3_1.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
    }));
    return `${S3_PREFIX}${key}`;
}
async function presignGetUrl(key) {
    return (0, s3_request_presigner_1.getSignedUrl)(getS3Client(), new client_s3_1.GetObjectCommand({ Bucket: config_1.config.s3.bucket, Key: key }), { expiresIn: config_1.config.s3.presignTtlSeconds });
}
async function resolveStoredImageUrl(stored) {
    if (!isS3Ref(stored))
        return stored;
    const key = stored.slice(S3_PREFIX.length);
    try {
        return (await presignGetUrl(key));
    }
    catch (err) {
        console.error("Failed to presign S3 object:", err);
        return stored;
    }
}
//# sourceMappingURL=s3.js.map