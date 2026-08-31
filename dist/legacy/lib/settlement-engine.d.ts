export type SettlementEngineSettings = {
    intervalMinutes: number;
    adjustmentWindowHours: number;
    gracePeriodDays: number;
    maxCampaignsPerCycle: number;
    platformFeePercent: number;
    cardFeePercent: number;
    cardFeeFixed: number;
    enabled: boolean;
};
export declare function settlementEngineSettings(): SettlementEngineSettings;
export type SettlementPipelineResult = {
    closed: number;
    frozen: number;
    snapshots: number;
    emailed: number;
    errors: string[];
};
export declare function closeExpiredCampaigns(settings?: SettlementEngineSettings): Promise<number>;
export declare function freezeAdjustmentWindows(settings?: SettlementEngineSettings): Promise<number>;
export declare function createSnapshotsForFrozenCampaigns(settings?: SettlementEngineSettings): Promise<number>;
export declare function createSnapshotForCampaign(campaignId: number, settings?: SettlementEngineSettings): Promise<void>;
export declare function updateSettlementAchStatus(input: {
    campaignId: number;
    settlementId: number;
    achStatus: string;
    performedBy?: string;
}): Promise<{
    achStatus: string;
}>;
export declare function runSettlementPipeline(): Promise<SettlementPipelineResult>;
export declare function lockCampaignForSettlement(campaignId: number): Promise<void>;
export declare function campaignHasFrozenSnapshot(campaignId: number): Promise<boolean>;
