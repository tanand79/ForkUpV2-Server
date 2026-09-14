export declare const DEFAULT_INVITE_RESPONSE_DAYS = 7;
export declare function computeRespondByDate(input: {
    sentDate?: string | Date | null;
    startOrEventDate?: string | Date | null;
}): string;
export declare function isRespondByPassed(respondByDate?: string | Date | null): boolean;
export type SetupReadiness = {
    setupStatus: "pending" | "needs_info" | "ready" | "complete";
    settlementReadyStatus: "pending" | "needs_info" | "ready";
    marketingReadyStatus: "pending" | "ready" | "blocked";
    inviteStatusAfterAccept: "needs_info" | "ready";
};
export declare function deriveSetupReadiness(input: {
    achAuthorized?: boolean;
    billingContactEmail?: string | null;
    settlementContactEmail?: string | null;
    authorizedRepresentative?: string | null;
}): SetupReadiness;
