export type GuestClaimEmailKind = "business" | "campaign";
export type GuestClaimEmailInput = {
    kind: GuestClaimEmailKind;
    entityName: string;
    claimUrl: string;
    publicUrl?: string | null;
    expiresInDays: number;
};
export type RenderedGuestClaimEmail = {
    subject: string;
    body: string;
    html: string;
};
export declare function renderGuestClaimEmail(input: GuestClaimEmailInput): RenderedGuestClaimEmail;
