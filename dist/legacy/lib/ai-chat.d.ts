export type AiChatOptions = {
    system: string;
    user: string;
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
};
export declare function aiProviderName(): "bedrock" | "lovable" | "none";
export declare function aiChat(options: AiChatOptions): Promise<string>;
export declare function parseAiJson<T extends Record<string, unknown>>(raw: string): T;
