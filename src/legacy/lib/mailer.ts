import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import nodemailer from "nodemailer";
import { pool } from "../db/pool";
import { getPlatformSettings } from "./platform-settings";

export type StakeholderRole =
  | "nonprofit"
  | "business"
  | "ambassador"
  | "supporter"
  | "admin";

/** Who the message is conceptually from (From display name + Reply-To). */
export type EmailSenderParty = "nonprofit" | "business" | "platform";

export type SendEmailInput = {
  to: string;
  name?: string | null;
  subject: string;
  body: string;
  emailType: string;
  campaignId?: number | null;
  /** Required when senderParty is "business" (or inferred) so Reply-To / From name resolve. */
  businessId?: number | null;
  stakeholderRole?: StakeholderRole | null;
  relatedToken?: string | null;
  /**
   * When true, skips sending if a prior non-failed email_log row already exists
   * for the same recipient + emailType + relatedToken. Prevents duplicate sends
   * (e.g. when a campaign is re-launched). Requires relatedToken to take effect.
   */
  onlyOnce?: boolean;
  /**
   * Optional Reply-To. When omitted, mailer may fill from senderParty resolution.
   */
  replyTo?: string | null;
  /**
   * Optional From display name. When omitted, mailer may fill from senderParty.
   * Address always remains Super Admin smtp_from.
   */
  fromName?: string | null;
  /**
   * Explicit sender party. When omitted, inferred globally:
   * - platformSender / admin-style → platform
   * - stakeholderRole business → nonprofit (NPO → business)
   * - stakeholderRole nonprofit + businessId → business (business → NPO)
   * - otherwise → platform
   */
  senderParty?: EmailSenderParty;
  /**
   * When true, keep plain Super Admin smtp_from (no org From name / Reply-To
   * unless the caller already set fromName / replyTo). Prefer senderParty:
   * "platform" for new code; this flag remains for existing call sites.
   */
  platformSender?: boolean;
};

export type SendEmailResult = {
  status: "sent" | "failed" | "skipped";
  provider: "ses" | "smtp" | "noop";
  messageId: string | null;
  /** Present when status is failed (or skipped with a known reason). */
  errorMessage?: string | null;
};

let sesClient: SESClient | null = null;

/**
 * Escapes a display name for an RFC 5322 mailbox "Name" <addr> From header.
 * Inputs: raw display name. Outputs: quoted-safe string (no surrounding quotes).
 */
function escapeFromDisplayName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"').trim();
}

/**
 * Builds the SMTP From value: keeps authenticated smtp_from address, optionally
 * prefixes the campaign creator / nonprofit display name.
 * Inputs: smtpFrom address, optional fromName. Outputs: header From string.
 */
function formatSmtpFrom(smtpFrom: string, fromName?: string | null): string {
  const addr = smtpFrom.trim();
  const name = typeof fromName === "string" ? fromName.trim() : "";
  if (!name) return addr;
  return `"${escapeFromDisplayName(name)}" <${addr}>`;
}

/**
 * Loads nonprofit contact_email + organization_name for a campaign.
 * Inputs: campaignId. Outputs: { replyTo, fromName } (nulls when missing).
 */
async function resolveNonprofitSender(
  campaignId: number,
): Promise<{ replyTo: string | null; fromName: string | null }> {
  try {
    const { rows } = await pool.query<{
      contact_email: string | null;
      organization_name: string | null;
    }>(
      `SELECT n.contact_email, n.organization_name
       FROM campaigns c
       JOIN nonprofits n ON n.id = c.nonprofit_id
       WHERE c.id = $1
       LIMIT 1`,
      [campaignId],
    );
    const row = rows[0];
    if (!row) return { replyTo: null, fromName: null };
    const email =
      typeof row.contact_email === "string" ? row.contact_email.trim() : "";
    const org =
      typeof row.organization_name === "string"
        ? row.organization_name.trim()
        : "";
    return {
      replyTo: email.includes("@") ? email : null,
      fromName: org || null,
    };
  } catch (err) {
    console.error("[mailer] resolveNonprofitSender failed:", err);
    return { replyTo: null, fromName: null };
  }
}

/**
 * Loads business contact_email + business_name for business→NPO style mail.
 * Inputs: businessId. Outputs: { replyTo, fromName } (nulls when missing).
 */
async function resolveBusinessSender(
  businessId: number,
): Promise<{ replyTo: string | null; fromName: string | null }> {
  try {
    const { rows } = await pool.query<{
      contact_email: string | null;
      business_name: string | null;
    }>(
      `SELECT contact_email, business_name FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId],
    );
    const row = rows[0];
    if (!row) return { replyTo: null, fromName: null };
    const email =
      typeof row.contact_email === "string" ? row.contact_email.trim() : "";
    const name =
      typeof row.business_name === "string" ? row.business_name.trim() : "";
    return {
      replyTo: email.includes("@") ? email : null,
      fromName: name || null,
    };
  } catch (err) {
    console.error("[mailer] resolveBusinessSender failed:", err);
    return { replyTo: null, fromName: null };
  }
}

/**
 * Global sender-party rule (NPO→business / business→NPO / ForkUp platform).
 * Inputs: SendEmailInput. Outputs: resolved EmailSenderParty.
 */
function inferSenderParty(input: SendEmailInput): EmailSenderParty {
  if (input.platformSender) return "platform";
  if (input.senderParty === "platform" || input.senderParty === "nonprofit" || input.senderParty === "business") {
    return input.senderParty;
  }
  // NPO → business (invites, lifecycle, settlement to partners, etc.)
  if (input.stakeholderRole === "business") return "nonprofit";
  // Business → NPO when we know which business acted
  if (input.stakeholderRole === "nonprofit" && input.businessId) return "business";
  // Admin / supporter / nonprofit system notices / unknown → ForkUp platform
  return "platform";
}

/**
 * Fills replyTo / fromName from the inferred sender party when the caller did
 * not supply them. Never changes the SMTP From address (always smtp_from).
 * Inputs: SendEmailInput. Outputs: same input with sender fields set.
 */
async function enrichSenderFromCampaign(
  input: SendEmailInput,
): Promise<SendEmailInput> {
  const needsReplyTo = !input.replyTo?.trim();
  const needsFromName = !input.fromName?.trim();
  if (!needsReplyTo && !needsFromName) return input;

  const party = inferSenderParty(input);
  if (party === "platform") return input;

  let sender: { replyTo: string | null; fromName: string | null } = {
    replyTo: null,
    fromName: null,
  };
  if (party === "nonprofit" && input.campaignId) {
    sender = await resolveNonprofitSender(input.campaignId);
  } else if (party === "business" && input.businessId) {
    sender = await resolveBusinessSender(input.businessId);
  }

  return {
    ...input,
    replyTo: needsReplyTo ? sender.replyTo : input.replyTo,
    fromName: needsFromName ? sender.fromName : input.fromName,
  };
}

function isSesConfigured(): boolean {
  return Boolean(
    process.env.SES_FROM_EMAIL?.trim() && process.env.AWS_REGION?.trim(),
  );
}

function getSesClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({ region: process.env.AWS_REGION });
  }
  return sesClient;
}

async function recordEmailLog(
  input: SendEmailInput,
  result: SendEmailResult,
  errorMessage: string | null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO email_log (
        campaign_id, recipient_email, recipient_name, stakeholder_role,
        email_type, subject, body, provider, provider_message_id,
        status, error_message, related_token
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.campaignId ?? null,
        input.to,
        input.name ?? null,
        input.stakeholderRole ?? null,
        input.emailType,
        input.subject,
        input.body,
        result.provider,
        result.messageId,
        result.status,
        errorMessage,
        input.relatedToken ?? null,
      ],
    );
  } catch (err) {
    // Logging the email must never break the request flow.
    console.error("[mailer] Failed to write email_log entry:", err);
  }
}

async function alreadySent(input: SendEmailInput): Promise<boolean> {
  if (!input.onlyOnce || !input.relatedToken) return false;
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM email_log
       WHERE related_token = $1
         AND email_type = $2
         AND LOWER(recipient_email) = LOWER($3)
         AND status IN ('sent', 'skipped')
       LIMIT 1`,
      [input.relatedToken, input.emailType, input.to],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error("[mailer] Dedupe check failed; proceeding with send:", err);
    return false;
  }
}

async function resolveEmailProvider(): Promise<"ses" | "smtp" | "noop"> {
  try {
    const s = await getPlatformSettings(["email_provider"]);
    const p = (s.email_provider || "").trim().toLowerCase();
    // SES is hidden in Super Admin — treat legacy "ses" as SMTP.
    if (p === "noop") return "noop";
    if (p === "smtp" || p === "ses") return "smtp";
  } catch {
    /* fall through */
  }
  return "smtp";
}

async function sendViaSmtp(input: SendEmailInput): Promise<SendEmailResult> {
  const s = await getPlatformSettings([
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_pass",
    "smtp_from",
    "smtp_secure",
  ]);
  if (!s.smtp_host?.trim() || !s.smtp_from?.trim()) {
    const result: SendEmailResult = {
      status: "skipped",
      provider: "smtp",
      messageId: null,
      errorMessage: "SMTP host/from not configured",
    };
    console.info(`[mailer] SMTP incomplete — skipping. type=${input.emailType} to=${input.to}`);
    await recordEmailLog(input, result, result.errorMessage ?? null);
    return result;
  }

  try {
    const transport = nodemailer.createTransport({
      host: s.smtp_host,
      port: Number(s.smtp_port || 587),
      secure: s.smtp_secure === "true",
      auth:
        s.smtp_user && s.smtp_pass
          ? { user: s.smtp_user, pass: s.smtp_pass }
          : undefined,
    });
    const replyTo =
      typeof input.replyTo === "string" && input.replyTo.includes("@")
        ? input.replyTo.trim()
        : undefined;
    const info = await transport.sendMail({
      from: formatSmtpFrom(s.smtp_from, input.fromName),
      to: input.to,
      subject: input.subject,
      text: input.body,
      ...(replyTo ? { replyTo } : {}),
    });
    const result: SendEmailResult = {
      status: "sent",
      provider: "smtp",
      messageId: typeof info.messageId === "string" ? info.messageId : null,
    };
    await recordEmailLog(input, result, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mailer] SMTP send failed. type=${input.emailType} to=${input.to}:`, message);
    const result: SendEmailResult = {
      status: "failed",
      provider: "smtp",
      messageId: null,
      errorMessage: message,
    };
    await recordEmailLog(input, result, message);
    return result;
  }
}

async function sendViaSes(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isSesConfigured()) {
    const result: SendEmailResult = {
      status: "skipped",
      provider: "noop",
      messageId: null,
    };
    console.info(
      `[mailer] SES not configured — skipping send. type=${input.emailType} to=${input.to}`,
    );
    await recordEmailLog(input, result, null);
    return result;
  }

  try {
    const command = new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [input.to] },
      Message: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: { Text: { Data: input.body, Charset: "UTF-8" } },
      },
    });
    const response = await getSesClient().send(command);
    const result: SendEmailResult = {
      status: "sent",
      provider: "ses",
      messageId: response.MessageId ?? null,
    };
    await recordEmailLog(input, result, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mailer] SES send failed. type=${input.emailType} to=${input.to}:`, message);
    const result: SendEmailResult = {
      status: "failed",
      provider: "ses",
      messageId: null,
      errorMessage: message,
    };
    await recordEmailLog(input, result, message);
    return result;
  }
}

/**
 * Sends an email via Super Admin SMTP (or no-op). Legacy SES setting
 * is treated as SMTP. Never throws into the caller.
 * Global From/Reply-To rule (address always smtp_from):
 * - NPO → business (stakeholderRole business) → nonprofit name / contact
 * - Business → NPO (senderParty business or nonprofit + businessId) → business
 * - ForkUp admin / system (platformSender or default) → plain smtp_from
 * Explicit fromName / replyTo always win when provided.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const enriched = await enrichSenderFromCampaign(input);

  if (await alreadySent(enriched)) {
    return { status: "skipped", provider: "noop", messageId: null };
  }

  const provider = await resolveEmailProvider();
  if (provider === "noop") {
    const result: SendEmailResult = { status: "skipped", provider: "noop", messageId: null };
    console.info(`[mailer] Provider=noop — skipping. type=${enriched.emailType} to=${enriched.to}`);
    await recordEmailLog(enriched, result, null);
    return result;
  }
  if (provider === "smtp") return sendViaSmtp(enriched);
  return sendViaSes(enriched);
}

/** Resolves the public frontend base URL used to build stakeholder links. */
export function resolveFrontendBaseUrl(): string {
  const candidate =
    process.env.FRONTEND_URL?.split(",")[0]?.trim() ||
    (typeof process.env.CORS_ORIGIN === "string"
      ? process.env.CORS_ORIGIN.split(",")[0]?.trim()
      : "") ||
    "http://localhost:3000";
  return candidate.replace(/\/+$/, "");
}
