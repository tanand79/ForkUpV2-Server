import { Pool } from "pg";
import { config } from "../config";

let poolInstance: Pool | null = null;

function createPool() {
  const raw = config.databaseUrl;
  const useSsl = shouldUseSsl(raw);
  const connectionString = raw
    .replace(/([?&])ssl=(true|false)(&?)/i, (_match, prefix, _value, suffix) =>
      prefix === "?" && suffix ? "?" : "",
    )
    .replace(/[?&]$/, "");

  return new Pool({
    connectionString,
    ssl: useSsl
      ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
  });
}

function shouldUseSsl(raw: string): boolean {
  if (!/[?&]ssl=true/i.test(raw)) return false;

  const hostMatch = raw.match(/@([^/?]+)/);
  const host = hostMatch?.[1]?.split(":")[0]?.toLowerCase() ?? "";
  return host !== "localhost" && host !== "127.0.0.1";
}

export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = createPool();
  }
  return poolInstance;
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getPool(), prop, receiver);
    return typeof value === "function" ? value.bind(getPool()) : value;
  },
});
