/**
 * Require a signed-in platform superadmin for Super Admin APIs.
 * Inputs: Express request with Bearer token.
 * Output: AuthUser or null (and writes 401/403 when used via requirePlatformAdmin).
 */
import type { Request, Response, NextFunction } from "express";
import { bearerToken, resolveAuthUser, type AuthUser } from "./auth";

export async function resolvePlatformAdmin(req: Request): Promise<AuthUser | null> {
  const user = await resolveAuthUser(bearerToken(req));
  if (!user || !user.isPlatformAdmin) return null;
  return user;
}

export async function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await resolvePlatformAdmin(req);
    if (!user) {
      res.status(401).json({ error: "Superadmin authentication required" });
      return;
    }
    (req as Request & { platformAdmin?: AuthUser }).platformAdmin = user;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to authorize superadmin" });
  }
}
