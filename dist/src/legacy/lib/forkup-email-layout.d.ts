export type ForkUpEmailLayoutInput = {
    subject: string;
    bodyText: string;
    headline?: string | null;
    ctaLabel?: string | null;
};
export declare function firstUrlInText(text: string): string | null;
export declare function wrapForkUpEmailHtml(input: ForkUpEmailLayoutInput): string;
