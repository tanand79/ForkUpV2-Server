export declare const FORKUP_EMAIL_LOGO_CID = "forkup-logo@forkup";
export type ForkUpEmailLayoutInput = {
    subject: string;
    bodyText: string;
    headline?: string | null;
    ctaLabel?: string | null;
};
export declare function resolveEmailLogoUrl(): string;
export declare function loadForkUpEmailLogoBuffer(): Buffer | null;
export declare function forkUpEmailHeaderCellHtml(): string;
export declare function firstUrlInText(text: string): string | null;
export declare function wrapForkUpEmailHtml(input: ForkUpEmailLayoutInput): string;
