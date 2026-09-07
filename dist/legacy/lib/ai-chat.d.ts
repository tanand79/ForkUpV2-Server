export type AiChatOptions = {
    system: string;
    user: string;
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
    modelId?: string;
    userId?: number | null;
};
export type AiImagePart = {
    bytes: Buffer;
    mediaType: string;
};
export declare function aiProviderName(): "bedrock" | "lovable" | "none";
export declare function resolveReceiptBedrockModelId(modelOverride?: string | null, userId?: number | null): Promise<string>;
export declare function aiChatWithImages(options: AiChatOptions & {
    images: AiImagePart[];
}): Promise<string>;
export declare function aiChat(options: AiChatOptions): Promise<string>;
export declare function parseAiJson<T extends Record<string, unknown>>(raw: string): T;
