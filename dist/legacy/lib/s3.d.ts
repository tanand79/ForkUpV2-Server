export declare function isS3Enabled(): boolean;
export declare function isS3Ref(stored: string | null | undefined): boolean;
export declare function uploadImageToS3(buffer: Buffer, mimeType: string, prefix: string): Promise<string>;
export declare function presignGetUrl(key: string): Promise<string>;
export declare function resolveStoredImageUrl<T extends string | null | undefined>(stored: T): Promise<T>;
