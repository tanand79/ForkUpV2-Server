export type StakeholderRole = "nonprofit" | "business" | "ambassador" | "supporter" | "admin";
export type SendEmailInput = {
    to: string;
    name?: string | null;
    subject: string;
    body: string;
    emailType: string;
    campaignId?: number | null;
    stakeholderRole?: StakeholderRole | null;
    relatedToken?: string | null;
    onlyOnce?: boolean;
    replyTo?: string | null;
    fromName?: string | null;
    platformSender?: boolean;
};
export type SendEmailResult = {
    status: "sent" | "failed" | "skipped";
    provider: "ses" | "smtp" | "noop";
    messageId: string | null;
    errorMessage?: string | null;
};
export declare function sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
export declare function resolveFrontendBaseUrl(): string;
