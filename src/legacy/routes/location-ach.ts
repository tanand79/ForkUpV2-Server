/**
 * Location ACH settings API — Node stack (no .NET wiring).
 *
 * GET  /locations/:locationId/ach
 *   Auth: business org member or business contact email.
 *   Response: masked routing/account + authorization metadata.
 *
 * POST /locations/:locationId/ach
 *   Body: bank fields + optional signatureBase64; routing/account encrypted at rest.
 *   Response: { ok: true, locationId, hasAchData }
 *
 * Mounted under /api/business.
 */
import fs from "fs";
import path from "path";
import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import {
  decryptAchField,
  encryptAchField,
  isAchEncryptionConfigured,
  maskAchValue,
} from "../lib/ach-encryption";
import { pool } from "../db/pool";

export const locationAchRouter = Router();

const SIG_DIR = path.join(process.cwd(), "uploads", "ach-signatures");

function ensureSigDir() {
  try {
    fs.mkdirSync(SIG_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not create ACH signature directory:", err);
  }
}

async function userMayAccessLocation(
  userId: number,
  userEmail: string,
  locationId: number,
): Promise<{ ok: true; businessId: number } | { ok: false; status: number; error: string }> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT bl.id, bl.business_id, b.contact_email
     FROM business_locations bl
     JOIN businesses b ON b.id = bl.business_id
     WHERE bl.id = $1`,
    [locationId],
  );
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "Location not found" };
  }
  const businessId = Number(rows[0].business_id);
  const contactEmail =
    typeof rows[0].contact_email === "string" ? rows[0].contact_email.trim().toLowerCase() : "";

  if (contactEmail && userEmail.toLowerCase() === contactEmail) {
    return { ok: true, businessId };
  }

  const { rows: membership } = await pool.query<QueryResultRow>(
    `SELECT 1 FROM organization_users
     WHERE organization_type = 'business' AND organization_id = $1 AND user_id = $2`,
    [businessId, userId],
  );
  if (membership.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this business location" };
  }
  return { ok: true, businessId };
}

function saveSignatureBase64(locationId: number, base64: string): string {
  ensureSigDir();
  let raw = base64;
  if (raw.includes(",")) raw = raw.split(",")[1] ?? "";
  const bytes = Buffer.from(raw, "base64");
  const fileName = `${locationId}_${Date.now()}.png`;
  const filePath = path.join(SIG_DIR, fileName);
  fs.writeFileSync(filePath, bytes);
  return `/uploads/ach-signatures/${fileName}`;
}

/**
 * GET /locations/:locationId/ach
 * Returns masked ACH settings for a business location.
 */
locationAchRouter.get("/locations/:locationId/ach", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const locationId = Number(req.params.locationId);
    if (!locationId) {
      res.status(400).json({ error: "locationId is required" });
      return;
    }

    const access = await userMayAccessLocation(user.id, user.email, locationId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, location_name,
              ach_bank_name, ach_account_holder_name, ach_account_type,
              ach_routing_number, ach_account_number, ach_account_last4,
              ach_authorization_status, ach_authorized_by, ach_authorized_email,
              ach_authorized_at, ach_last_updated_at, ach_signature_path, ach_contact_email
       FROM business_locations WHERE id = $1`,
      [locationId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    let routingMasked = "";
    let accountMasked = "";
    if (isAchEncryptionConfigured()) {
      try {
        routingMasked = maskAchValue(decryptAchField(row.ach_routing_number as string | null));
        accountMasked = maskAchValue(decryptAchField(row.ach_account_number as string | null));
      } catch (err) {
        console.error("ACH decrypt failed for location", locationId, err);
      }
    }

    const hasAchData = Boolean(row.ach_bank_name || row.ach_account_number || row.ach_account_last4);

    res.json({
      locationId: Number(row.id),
      locationName: row.location_name,
      achBankName: row.ach_bank_name ?? null,
      achAccountHolderName: row.ach_account_holder_name ?? null,
      achAccountType: row.ach_account_type ?? null,
      achRoutingNumberMasked: routingMasked || null,
      achAccountNumberMasked: accountMasked || null,
      achAccountLast4: row.ach_account_last4 ?? null,
      achAuthorizationStatus: row.ach_authorization_status ?? "pending",
      achAuthorizedBy: row.ach_authorized_by ?? null,
      achAuthorizedEmail: row.ach_authorized_email ?? null,
      achAuthorizedAt: row.ach_authorized_at ?? null,
      achLastUpdatedAt: row.ach_last_updated_at ?? null,
      achSignaturePath: row.ach_signature_path ?? null,
      achContactEmail: row.ach_contact_email ?? null,
      hasAchData,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load ACH settings" });
  }
});

/**
 * POST /locations/:locationId/ach
 * Saves encrypted bank details + authorization metadata for a location.
 */
locationAchRouter.post("/locations/:locationId/ach", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!isAchEncryptionConfigured()) {
      res.status(503).json({
        error: "ACH encryption is not configured. Set ACH_ENCRYPTION_KEY and ACH_ENCRYPTION_IV.",
      });
      return;
    }

    const locationId = Number(req.params.locationId);
    if (!locationId) {
      res.status(400).json({ error: "locationId is required" });
      return;
    }

    const access = await userMayAccessLocation(user.id, user.email, locationId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const accountType =
      typeof body.achAccountType === "string" ? body.achAccountType.trim().toLowerCase() : null;
    if (accountType && accountType !== "checking" && accountType !== "savings") {
      res.status(400).json({ error: "achAccountType must be checking or savings" });
      return;
    }

    const routingPlain =
      typeof body.achRoutingNumber === "string" ? body.achRoutingNumber.trim() : "";
    const accountPlain =
      typeof body.achAccountNumber === "string" ? body.achAccountNumber.trim() : "";

    const encryptedRouting = routingPlain ? encryptAchField(routingPlain) : null;
    const encryptedAccount = accountPlain ? encryptAchField(accountPlain) : null;
    const last4 =
      accountPlain.length >= 4
        ? accountPlain.slice(-4)
        : typeof body.achAccountLast4 === "string"
          ? body.achAccountLast4.slice(-4)
          : null;

    let signaturePath: string | null = null;
    if (typeof body.achSignatureBase64 === "string" && body.achSignatureBase64.trim()) {
      signaturePath = saveSignatureBase64(locationId, body.achSignatureBase64.trim());
    }

    const authStatusRaw =
      typeof body.achAuthorizationStatus === "string"
        ? body.achAuthorizationStatus.trim().toLowerCase()
        : "authorized";
    const authStatus =
      authStatusRaw === "pending" || authStatusRaw === "revoked" ? authStatusRaw : "authorized";

    const authorizedBy =
      typeof body.achAuthorizedBy === "string" ? body.achAuthorizedBy.trim() : null;
    const authorizedEmail =
      typeof body.achAuthorizedEmail === "string"
        ? body.achAuthorizedEmail.trim().toLowerCase()
        : user.email;
    const contactEmail =
      typeof body.achContactEmail === "string" ? body.achContactEmail.trim().toLowerCase() : null;
    const bankName = typeof body.achBankName === "string" ? body.achBankName.trim() : null;
    const holderName =
      typeof body.achAccountHolderName === "string" ? body.achAccountHolderName.trim() : null;

    await pool.query(
      `UPDATE business_locations SET
         ach_bank_name = COALESCE($1, ach_bank_name),
         ach_account_holder_name = COALESCE($2, ach_account_holder_name),
         ach_account_type = COALESCE($3, ach_account_type),
         ach_routing_number = COALESCE($4, ach_routing_number),
         ach_account_number = COALESCE($5, ach_account_number),
         ach_account_last4 = COALESCE($6, ach_account_last4),
         ach_authorization_status = $7,
         ach_authorized_by = COALESCE($8, ach_authorized_by),
         ach_authorized_email = COALESCE($9, ach_authorized_email),
         ach_authorized_at = CASE
           WHEN $7 = 'authorized' THEN COALESCE(ach_authorized_at, NOW())
           ELSE ach_authorized_at
         END,
         ach_last_updated_at = NOW(),
         ach_signature_path = COALESCE($10, ach_signature_path),
         ach_contact_email = COALESCE($11, ach_contact_email),
         updated_at = NOW()
       WHERE id = $12`,
      [
        bankName,
        holderName,
        accountType,
        encryptedRouting,
        encryptedAccount,
        last4,
        authStatus,
        authorizedBy,
        authorizedEmail,
        signaturePath,
        contactEmail,
        locationId,
      ],
    );

    res.json({
      ok: true,
      locationId,
      hasAchData: Boolean(bankName || encryptedAccount || last4),
      achAuthorizationStatus: authStatus,
      achSignaturePath: signaturePath,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save ACH settings" });
  }
});
