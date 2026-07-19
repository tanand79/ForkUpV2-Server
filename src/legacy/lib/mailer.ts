import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { pool } from "../db/pool";

export type StakeholderRole =
  | "nonprofit"
  | "business"
  | "ambassador"
  | "supporter"
  | "admin";

export type SendEmailInput = {
  to: string;
  name?: string | null;
  subject: string;
  body: string;
  emailType: string;
  campaignId?: number | null;
  stakeholderRole?: StakeholderRole | null;
  relatedToken?: string | null;
  /**
   * When true, skips sending if a prior non-failed email_log row already exists
   * for the same recipient + emailType + relatedToken. Prevents duplicate sends
   * (e.g. when a campaign is re-launched). Requires relatedToken to take effect.
   */
  onlyOnce?: boolean;
};

export type SendEmailResult = {
  status: "sent" | "failed" | "skipped";
  provider: "ses" | "noop";
  messageId: string | null;
};

let sesClient: SESClient | null = null;

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

/**
 * Sends an email via AWS SES when configured, otherwise falls back to a no-op
 * (console log + skipped email_log row). Never throws into the caller so that
 * existing request flows are unaffected by email delivery problems.
 */
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

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (await alreadySent(input)) {
    return { status: "skipped", provider: "noop", messageId: null };
  }

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
    };
    await recordEmailLog(input, result, message);
    return result;
  }
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
