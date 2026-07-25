import type { Request } from "express";
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
export declare function generateSessionToken(): string;
export declare function sessionExpiry(): Date;
export type AuthUser = {
    id: number;
    email: string;
    fullName: string | null;
    username: string | null;
    isPlatformAdmin: boolean;
    organizations: {
        organizationType: "nonprofit" | "business";
        organizationId: number;
        role: string;
    }[];
};
export declare function resolveAuthUser(token: string | undefined): Promise<AuthUser | null>;
export declare function bearerToken(req: Request): string | undefined;
