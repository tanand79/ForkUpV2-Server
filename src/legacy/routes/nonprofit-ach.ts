/**
 * Nonprofit ACH settings API — mirrors business location ACH (Task 19).
 *
 * GET  /nonprofits/:nonprofitId/ach
 *   Auth: nonprofit org member or nonprofit contact email.
 *   Response: masked routing/account + authorization metadata.
 *
 * POST /nonprofits/:nonprofitId/ach
 *   Body: bank fields + optional signatureBase64; routing/account encrypted at rest.
 *   Response: { ok: true, nonprofitId, hasAchData }
 *
 * Mounted under /api/profiles.
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

export const nonprofitAchRouter = Router();

const SIG_DIR = path.join(process.cwd(), "uploads", "nonprofit-ach-signatures");

function ensureSigDir() {
  try {
    fs.mkdirSync(SIG_DIR, { recursive: true });
  } catch (err) {
    console.warn("Could not create nonprofit ACH signature directory:", err);
  }
}

async function userMayAccessNonprofit(
  userId: number,
  userEmail: string,
  nonprofitId: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { rows } = await pool.query<QueryResultRow>(
    `SELECT id, contact_email FROM nonprofits WHERE id = $1`,
    [nonprofitId],
  );
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "Nonprofit not found" };
  }
  const contactEmail =
    typeof rows[0].contact_email === "string" ? rows[0].contact_email.trim().toLowerCase() : "";

  if (contactEmail && userEmail.toLowerCase() === contactEmail) {
    return { ok: true };
  }

  const { rows: membership } = await pool.query<QueryResultRow>(
    `SELECT 1 FROM organization_users
     WHERE organization_type = 'nonprofit' AND organization_id = $1 AND user_id = $2`,
    [nonprofitId, userId],
  );
  if (membership.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this nonprofit" };
  }
  return { ok: true };
}

function saveSignatureBase64(nonprofitId: number, base64: string): string {
  ensureSigDir();
  let raw = base64;
  if (raw.includes(",")) raw = raw.split(",")[1] ?? "";
  const bytes = Buffer.from(raw, "base64");
  const fileName = `np_${nonprofitId}_${Date.now()}.png`;
  const filePath = path.join(SIG_DIR, fileName);
  fs.writeFileSync(filePath, bytes);
  return `/uploads/nonprofit-ach-signatures/${fileName}`;
}

nonprofitAchRouter.get("/nonprofits/:nonprofitId/ach", async (req, res) => {
  try {
    const user = await resolveAuthUser(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const nonprofitId = Number(req.params.nonprofitId);
    if (!nonprofitId) {
      res.status(400).json({ error: "nonprofitId is required" });
      return;
    }

    const access = await userMayAccessNonprofit(user.id, user.email, nonprofitId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const { rows } = await pool.query<QueryResultRow>(
      `SELECT id, organization_name,
              ach_bank_name, ach_account_holder_name, ach_account_type,
              ach_routing_number, ach_account_number, ach_account_last4,
              ach_authorization_status, ach_authorized_by, ach_authorized_email,
              ach_authorized_at, ach_last_updated_at, ach_signature_path, ach_contact_email
       FROM nonprofits WHERE id = $1`,
      [nonprofitId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Nonprofit not found" });
      return;
    }

    let routingMasked = "";
    let accountMasked = "";
    if (isAchEncryptionConfigured()) {
      try {
        routingMasked = maskAchValue(decryptAchField(row.ach_routing_number as string | null));
        accountMasked = maskAchValue(decryptAchField(row.ach_account_number as string | null));
      } catch (err) {
        console.error("ACH decrypt failed for nonprofit", nonprofitId, err);
      }
    }

    const hasAchData = Boolean(row.ach_bank_name || row.ach_account_number || row.ach_account_last4);

    res.json({
      nonprofitId: Number(row.id),
      organizationName: row.organization_name,
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
    res.status(500).json({ error: "Failed to load nonprofit ACH settings" });
  }
});

nonprofitAchRouter.post("/nonprofits/:nonprofitId/ach", async (req, res) => {
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

    const nonprofitId = Number(req.params.nonprofitId);
    if (!nonprofitId) {
      res.status(400).json({ error: "nonprofitId is required" });
      return;
    }

    const access = await userMayAccessNonprofit(user.id, user.email, nonprofitId);
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
      signaturePath = saveSignatureBase64(nonprofitId, body.achSignatureBase64.trim());
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
      `UPDATE nonprofits SET
         ach_bank_name = COALESCE($1, ach_bank_name),
         ach_account_holder_name = COALESCE($2, ach_account_holder_name),
         ach_account_type = COALESCE($3, ach_account_type),
         ach_routing_number = COALESCE($4, ach_routing_number),
         ach_account_number = COALESCE($5, ach_account_number),
         ach_account_last4 = COALESCE($6, ach_account_last4),
         ach_authorization_status = $7::varchar,
         ach_authorized_by = COALESCE($8, ach_authorized_by),
         ach_authorized_email = COALESCE($9, ach_authorized_email),
         ach_authorized_at = CASE
           WHEN $7::text = 'authorized' THEN COALESCE(ach_authorized_at, NOW())
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
        nonprofitId,
      ],
    );

    res.json({
      ok: true,
      nonprofitId,
      hasAchData: Boolean(bankName || encryptedAccount || last4),
      achAuthorizationStatus: authStatus,
      achSignaturePath: signaturePath,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save nonprofit ACH settings" });
  }
});
