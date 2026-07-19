"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
exports.resolveFrontendBaseUrl = resolveFrontendBaseUrl;
const client_ses_1 = require("@aws-sdk/client-ses");
const pool_1 = require("../db/pool");
let sesClient = null;
function isSesConfigured() {
    return Boolean(process.env.SES_FROM_EMAIL?.trim() && process.env.AWS_REGION?.trim());
}
function getSesClient() {
    if (!sesClient) {
        sesClient = new client_ses_1.SESClient({ region: process.env.AWS_REGION });
    }
    return sesClient;
}
async function recordEmailLog(input, result, errorMessage) {
    try {
        await pool_1.pool.query(`INSERT INTO email_log (
        campaign_id, recipient_email, recipient_name, stakeholder_role,
        email_type, subject, body, provider, provider_message_id,
        status, error_message, related_token
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
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
        ]);
    }
    catch (err) {
        console.error("[mailer] Failed to write email_log entry:", err);
    }
}
async function alreadySent(input) {
    if (!input.onlyOnce || !input.relatedToken)
        return false;
    try {
        const { rowCount } = await pool_1.pool.query(`SELECT 1 FROM email_log
       WHERE related_token = $1
         AND email_type = $2
         AND LOWER(recipient_email) = LOWER($3)
         AND status IN ('sent', 'skipped')
       LIMIT 1`, [input.relatedToken, input.emailType, input.to]);
        return (rowCount ?? 0) > 0;
    }
    catch (err) {
        console.error("[mailer] Dedupe check failed; proceeding with send:", err);
        return false;
    }
}
async function sendEmail(input) {
    if (await alreadySent(input)) {
        return { status: "skipped", provider: "noop", messageId: null };
    }
    if (!isSesConfigured()) {
        const result = {
            status: "skipped",
            provider: "noop",
            messageId: null,
        };
        console.info(`[mailer] SES not configured — skipping send. type=${input.emailType} to=${input.to}`);
        await recordEmailLog(input, result, null);
        return result;
    }
    try {
        const command = new client_ses_1.SendEmailCommand({
            Source: process.env.SES_FROM_EMAIL,
            Destination: { ToAddresses: [input.to] },
            Message: {
                Subject: { Data: input.subject, Charset: "UTF-8" },
                Body: { Text: { Data: input.body, Charset: "UTF-8" } },
            },
        });
        const response = await getSesClient().send(command);
        const result = {
            status: "sent",
            provider: "ses",
            messageId: response.MessageId ?? null,
        };
        await recordEmailLog(input, result, null);
        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mailer] SES send failed. type=${input.emailType} to=${input.to}:`, message);
        const result = {
            status: "failed",
            provider: "ses",
            messageId: null,
        };
        await recordEmailLog(input, result, message);
        return result;
    }
}
function resolveFrontendBaseUrl() {
    const candidate = process.env.FRONTEND_URL?.split(",")[0]?.trim() ||
        (typeof process.env.CORS_ORIGIN === "string"
            ? process.env.CORS_ORIGIN.split(",")[0]?.trim()
            : "") ||
        "http://localhost:3000";
    return candidate.replace(/\/+$/, "");
}
//# sourceMappingURL=mailer.js.map