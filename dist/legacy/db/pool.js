"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.getPool = getPool;
const pg_1 = require("pg");
const config_1 = require("../config");
let poolInstance = null;
function createPool() {
    const raw = config_1.config.databaseUrl;
    const useSsl = shouldUseSsl(raw);
    const connectionString = raw
        .replace(/([?&])ssl=(true|false)(&?)/i, (_match, prefix, _value, suffix) => prefix === "?" && suffix ? "?" : "")
        .replace(/[?&]$/, "");
    return new pg_1.Pool({
        connectionString,
        ssl: useSsl
            ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
            : undefined,
    });
}
function shouldUseSsl(raw) {
    if (!/[?&]ssl=true/i.test(raw))
        return false;
    const hostMatch = raw.match(/@([^/?]+)/);
    const host = hostMatch?.[1]?.split(":")[0]?.toLowerCase() ?? "";
    return host !== "localhost" && host !== "127.0.0.1";
}
function getPool() {
    if (!poolInstance) {
        poolInstance = createPool();
    }
    return poolInstance;
}
exports.pool = new Proxy({}, {
    get(_target, prop, receiver) {
        const value = Reflect.get(getPool(), prop, receiver);
        return typeof value === "function" ? value.bind(getPool()) : value;
    },
});
//# sourceMappingURL=pool.js.map