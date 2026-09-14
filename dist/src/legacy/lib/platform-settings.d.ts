export declare function getPlatformSetting(key: string): Promise<string | null>;
export declare function getPlatformSettings(keys: string[]): Promise<Record<string, string>>;
export declare function setPlatformSetting(key: string, value: string, updatedByUserId?: number | null): Promise<void>;
export declare function setPlatformSettings(entries: Record<string, string>, updatedByUserId?: number | null): Promise<void>;
