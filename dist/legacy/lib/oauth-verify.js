"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyOAuthIdToken = verifyOAuthIdToken;
const crypto_1 = require("crypto");
function googleAudience() {
    return (process.env.GOOGLE_CLIENT_ID?.trim() ||
        process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ||
        "");
}
function appleAudience() {
    return (process.env.APPLE_CLIENT_ID?.trim() ||
        process.env.NEXT_PUBLIC_APPLE_CLIENT_ID?.trim() ||
        "");
}
async function verifyGoogleIdToken(idToken) {
    const aud = googleAudience();
    if (!aud) {
        throw new Error("Google sign-in is not configured (GOOGLE_CLIENT_ID).");
    }
    const upstream = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!upstream.ok) {
        throw new Error("Could not verify Google sign-in. Please try again.");
    }
    const payload = (await upstream.json());
    if (!payload.aud || payload.aud !== aud) {
        throw new Error("Google sign-in audience mismatch.");
    }
    if (!payload.email || payload.email_verified === "false") {
        throw new Error("Google account email is missing or unverified.");
    }
    if (!payload.sub) {
        throw new Error("Google sign-in subject missing.");
    }
    return {
        provider: "google",
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        fullName: payload.name?.trim() || null,
    };
}
function base64UrlToBuffer(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, "base64");
}
async function verifyAppleIdToken(idToken) {
    const aud = appleAudience();
    if (!aud) {
        throw new Error("Apple sign-in is not configured (APPLE_CLIENT_ID).");
    }
    const parts = idToken.split(".");
    if (parts.length !== 3) {
        throw new Error("Invalid Apple identity token.");
    }
    const header = JSON.parse(base64UrlToBuffer(parts[0]).toString("utf8"));
    const payload = JSON.parse(base64UrlToBuffer(parts[1]).toString("utf8"));
    if (payload.iss !== "https://appleid.apple.com") {
        throw new Error("Invalid Apple token issuer.");
    }
    const audienceOk = Array.isArray(payload.aud)
        ? payload.aud.includes(aud)
        : payload.aud === aud;
    if (!audienceOk) {
        throw new Error("Apple sign-in audience mismatch.");
    }
    if (!payload.exp || payload.exp * 1000 < Date.now()) {
        throw new Error("Apple sign-in token expired.");
    }
    if (!payload.sub) {
        throw new Error("Apple sign-in subject missing.");
    }
    const keysRes = await fetch("https://appleid.apple.com/auth/keys");
    if (!keysRes.ok) {
        throw new Error("Could not load Apple signing keys.");
    }
    const { keys } = (await keysRes.json());
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
        throw new Error("Apple signing key not found.");
    }
    const keyObject = (0, crypto_1.createPublicKey)({ key: jwk, format: "jwk" });
    const verifier = (0, crypto_1.createVerify)("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    const signatureOk = verifier.verify(keyObject, base64UrlToBuffer(parts[2]));
    if (!signatureOk) {
        throw new Error("Apple sign-in signature invalid.");
    }
    const email = payload.email?.trim().toLowerCase();
    if (!email) {
        throw new Error("Apple did not share an email. Use email sign-in, or try Apple again and allow email sharing.");
    }
    return {
        provider: "apple",
        subject: payload.sub,
        email,
        fullName: null,
    };
}
async function verifyOAuthIdToken(provider, idToken) {
    const token = idToken.trim();
    if (!token) {
        throw new Error("Sign-in token is required.");
    }
    if (provider === "google")
        return verifyGoogleIdToken(token);
    if (provider === "apple")
        return verifyAppleIdToken(token);
    throw new Error("Unsupported sign-in provider.");
}
//# sourceMappingURL=oauth-verify.js.map