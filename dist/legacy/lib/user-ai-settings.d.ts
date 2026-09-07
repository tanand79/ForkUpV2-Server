export declare function getUserAiBedrockModel(userId: number): Promise<string | null>;
export declare function setUserAiBedrockModel(userId: number, modelId: string): Promise<string>;
export declare function resolveUserBedrockModelId(input: {
    requestModelId?: string | null;
    userId?: number | null;
    platformSettingKey?: "ai_model_id" | "receipt_ai_model_id";
    envDefault?: string;
}): Promise<string>;
