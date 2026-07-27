export type BedrockModelPricingInput = {
    id: string;
    label: string;
    inputPer1M: number;
    outputPer1M: number;
};
export type BedrockModelLiveRate = {
    modelId: string;
    inputPer1M: number;
    outputPer1M: number;
    source: "aws" | "fallback";
};
export type BedrockPricingSnapshot = {
    rates: BedrockModelLiveRate[];
    pricingSource: "aws" | "fallback" | "mixed";
    pricingFetchedAt: string;
    awsModelCount: number;
};
export declare function getBedrockLivePricing(models: readonly BedrockModelPricingInput[]): Promise<BedrockPricingSnapshot>;
