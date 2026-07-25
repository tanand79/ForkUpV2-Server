import type { Request, Response, NextFunction } from "express";
import { type AuthUser } from "./auth";
export declare function resolvePlatformAdmin(req: Request): Promise<AuthUser | null>;
export declare function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void>;
