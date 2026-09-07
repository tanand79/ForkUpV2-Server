/**
 * Purpose: Sniff actual image bytes so Bedrock vision gets matching format + MIME.
 * Inputs: image buffer and optional client-declared MIME type.
 * Outputs: normalized mediaType string for Converse image blocks.
 */

/** Detect image MIME from magic bytes (ignores unreliable browser file.type). */
export function sniffImageMediaType(buffer: Buffer): string {
  if (buffer.length >= 8) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  return "image/jpeg";
}

/**
 * Purpose: Pick Bedrock-safe media type for receipt/check vision OCR.
 * Inputs: raw bytes + optional declared MIME from upload.
 * Outputs: sniffed MIME (bytes win over unreliable client file.type).
 */
export function normalizeImageMediaType(buffer: Buffer, declaredMime?: string | null): string {
  const sniffed = sniffImageMediaType(buffer);
  const declared = String(declaredMime ?? "").trim().toLowerCase();
  const declaredBase = declared.split(";")[0]?.trim() ?? "";
  if (!declaredBase || declaredBase === sniffed) return sniffed;
  // Always trust magic bytes when they disagree with the client label.
  return sniffed;
}
