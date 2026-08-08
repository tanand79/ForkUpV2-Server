"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAchEncryptionConfigured = isAchEncryptionConfigured;
exports.encryptAchField = encryptAchField;
exports.decryptAchField = decryptAchField;
exports.maskAchValue = maskAchValue;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
function padOrTruncate(buf, len) {
    if (buf.length === len)
        return buf;
    if (buf.length > len)
        return buf.subarray(0, len);
    const out = Buffer.alloc(len);
    buf.copy(out);
    return out;
}
function isAchEncryptionConfigured() {
    return Boolean(config_1.config.achEncryption.key && config_1.config.achEncryption.iv);
}
function getKeyIv() {
    if (!isAchEncryptionConfigured()) {
        throw new Error("ACH encryption is not configured (ACH_ENCRYPTION_KEY / ACH_ENCRYPTION_IV).");
    }
    return {
        key: padOrTruncate(Buffer.from(config_1.config.achEncryption.key, "utf8"), 32),
        iv: padOrTruncate(Buffer.from(config_1.config.achEncryption.iv, "utf8"), 16),
    };
}
function encryptAchField(plainText) {
    if (!plainText)
        return "";
    const { key, iv } = getKeyIv();
    const cipher = crypto_1.default.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return encrypted.toString("base64");
}
function decryptAchField(cipherText) {
    if (!cipherText)
        return "";
    const { key, iv } = getKeyIv();
    const decipher = crypto_1.default.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipherText, "base64")),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}
function maskAchValue(plain) {
    if (!plain)
        return "";
    if (plain.length <= 4)
        return plain;
    return `${"*".repeat(plain.length - 4)}${plain.slice(-4)}`;
}
//# sourceMappingURL=ach-encryption.js.map