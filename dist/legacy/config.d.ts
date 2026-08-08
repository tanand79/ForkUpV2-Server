export type DatabaseTarget = "local" | "production";
export declare const config: {
    nodeEnv: string;
    databaseTarget: DatabaseTarget;
    port: number;
    readonly databaseUrl: string;
    corsOrigin: string | string[];
    readonly automationSecret: string;
    s3: {
        region: string;
        bucket: string;
        presignTtlSeconds: number;
    };
    mindee: {
        readonly apiKey: string;
        readonly modelId: string;
        readonly apiUrl: string;
    };
    achEncryption: {
        readonly key: string;
        readonly iv: string;
    };
};
