import type { AuthUser } from "./auth";
import { type BusinessEmailContext, type BusinessEmailTemplateKey } from "./business-email-templates";
export type EmailTemplateScopeType = "nonprofit" | "business" | "fundraiser_user";
export type EmailTemplateRecord = {
    id: number | null;
    scopeType: EmailTemplateScopeType;
    scopeId: number;
    campaignId: number | null;
    templateKey: string;
    name: string;
    subject: string;
    body: string;
    defaultSenderUserId: number | null;
    defaultFromName: string | null;
    isActive: boolean;
    source: "database" | "system";
    canEdit: boolean;
};
export type TemplatePlaceholderContext = Record<string, string | null | undefined>;
declare const SAMPLE_CTX: BusinessEmailContext;
declare function parseScopeType(value: unknown): EmailTemplateScopeType | null;
declare function parsePositiveInt(value: unknown): number | null;
export declare function applyTemplatePlaceholders(template: string, context: TemplatePlaceholderContext): string;
export declare function businessContextToPlaceholders(ctx: BusinessEmailContext): TemplatePlaceholderContext;
export declare function assertEmailTemplateAccess(user: AuthUser, scopeType: EmailTemplateScopeType, scopeId: number, mode: "read" | "write"): string | null;
export declare function listEmailTemplates(input: {
    scopeType: EmailTemplateScopeType;
    scopeId: number;
    campaignId?: number | null;
    canEdit: boolean;
}): Promise<EmailTemplateRecord[]>;
export declare function resolveEmailTemplate(input: {
    scopeType: EmailTemplateScopeType;
    scopeId: number;
    templateKey: string;
    campaignId?: number | null;
}): Promise<{
    subject: string;
    body: string;
    name: string;
    defaultSenderUserId: number | null;
    defaultFromName: string | null;
    source: "database" | "system";
    id: number | null;
    campaignId: number | null;
} | null>;
export declare function applyNonprofitTemplateOverride(input: {
    nonprofitId: number;
    campaignId: number;
    templateKey: BusinessEmailTemplateKey;
    fallbackSubject: string;
    fallbackBody: string;
    context: BusinessEmailContext;
}): Promise<{
    subject: string;
    body: string;
    usedDatabase: boolean;
}>;
export declare function upsertEmailTemplate(input: {
    scopeType: EmailTemplateScopeType;
    scopeId: number;
    campaignId?: number | null;
    templateKey: string;
    name: string;
    subject: string;
    body: string;
    defaultSenderUserId?: number | null;
    defaultFromName?: string | null;
    userId: number;
}): Promise<EmailTemplateRecord>;
export declare function deactivateEmailTemplate(id: number, userId: number): Promise<boolean>;
export declare function getEmailTemplateById(id: number): Promise<EmailTemplateRecord | null>;
export { parseScopeType, parsePositiveInt, SAMPLE_CTX as EMAIL_TEMPLATE_SAMPLE_CONTEXT };
