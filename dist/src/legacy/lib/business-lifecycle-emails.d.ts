import { renderSettlementReady } from "./business-email-templates";
export type LifecycleSendResult = {
    sent: number;
    skipped: number;
    targeted: number;
};
export declare function sendInitialInvitationEmails(campaignId: number, options?: {
    onlyStatus?: string[];
    cblId?: number;
}): Promise<LifecycleSendResult>;
export declare function sendBusinessAcceptedConfirmation(campaignId: number, businessId: number): Promise<void>;
export declare function sendBusinessDeclinedConfirmation(campaignId: number, businessId: number): Promise<void>;
export declare function sendBusinessLifecycleBatch(input: {
    campaignId: number;
    templateKey: "invite_reminder" | "missing_info" | "launch_kit" | "starting_soon";
    invitationId?: number;
}): Promise<LifecycleSendResult>;
export declare function buildSettlementBusinessEmail(input: {
    businessName: string;
    nonprofitName: string;
    campaignTitle: string;
    dateRangeLabel: string;
    eligibleSales: number;
    donationAmount: number;
    forkupFee: number;
    reportUrl: string;
}): ReturnType<typeof renderSettlementReady>;
