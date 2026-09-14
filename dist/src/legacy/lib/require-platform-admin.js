"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePlatformAdmin = resolvePlatformAdmin;
exports.requirePlatformAdmin = requirePlatformAdmin;
const auth_1 = require("./auth");
async function resolvePlatformAdmin(req) {
    const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
    if (!user || !user.isPlatformAdmin)
        return null;
    return user;
}
async function requirePlatformAdmin(req, res, next) {
    try {
        const user = await resolvePlatformAdmin(req);
        if (!user) {
            res.status(401).json({ error: "Superadmin authentication required" });
            return;
        }
        req.platformAdmin = user;
        next();
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to authorize superadmin" });
    }
}
//# sourceMappingURL=require-platform-admin.js.map