/**
 * ACH field encryption — AES-256-CBC, Node-native (parity with old .NET EncryptionService).
 *
 * Purpose: encrypt/decrypt routing + account numbers before DB storage.
 * Inputs: plain UTF-8 strings; key/IV from ACH_ENCRYPTION_KEY / ACH_ENCRYPTION_IV.
 * Outputs: base64 ciphertext / plaintext; empty string passthrough for empty input.
 */
import crypto from "crypto";
import { config } from "../config";

function padOrTruncate(buf: Buffer, len: number): Buffer {
  if (buf.length === len) return buf;
  if (buf.length > len) return buf.subarray(0, len);
  const out = Buffer.alloc(len);
  buf.copy(out);
  return out;
}

export function isAchEncryptionConfigured(): boolean {
  return Boolean(config.achEncryption.key && config.achEncryption.iv);
}

function getKeyIv(): { key: Buffer; iv: Buffer } {
  if (!isAchEncryptionConfigured()) {
    throw new Error("ACH encryption is not configured (ACH_ENCRYPTION_KEY / ACH_ENCRYPTION_IV).");
  }
  return {
    key: padOrTruncate(Buffer.from(config.achEncryption.key, "utf8"), 32),
    iv: padOrTruncate(Buffer.from(config.achEncryption.iv, "utf8"), 16),
  };
}

/**
 * Encrypts a plaintext ACH field. Empty/null → empty string.
 */
export function encryptAchField(plainText: string | null | undefined): string {
  if (!plainText) return "";
  const { key, iv } = getKeyIv();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return encrypted.toString("base64");
}

/**
 * Decrypts a stored ACH field. Empty/null → empty string.
 */
export function decryptAchField(cipherText: string | null | undefined): string {
  if (!cipherText) return "";
  const { key, iv } = getKeyIv();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherText, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Mask all but last 4 characters for API responses. */
export function maskAchValue(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 4) return plain;
  return `${"*".repeat(plain.length - 4)}${plain.slice(-4)}`;
}
