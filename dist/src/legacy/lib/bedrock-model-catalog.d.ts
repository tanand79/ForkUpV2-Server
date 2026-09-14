export type BedrockModelCatalogEntry = {
    id: string;
    label: string;
    vendor: string;
    tier: string;
    blurb: string;
    inputPer1M: number;
    outputPer1M: number;
};
export declare const BEDROCK_MODEL_CATALOG: BedrockModelCatalogEntry[];
export declare const DEFAULT_BEDROCK_MODEL_ID = "amazon.nova-lite-v1:0";
export declare const DEPRECATED_BEDROCK_MODELS: Record<string, string>;
export declare function isAllowedBedrockModel(id: string): boolean;
export declare function migrateBedrockModelId(stored: string | null | undefined): string;
