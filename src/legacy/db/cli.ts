import path from "path";
import { fileURLToPath } from "url";

export type DbTaskOptions = {
  closePool?: boolean;
};

/** True when this file is executed directly (e.g. `tsx src/legacy/db/migrate.ts`). */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = path.resolve(entry).replace(/\\/g, "/").toLowerCase();
  const self = fileURLToPath(moduleUrl).replace(/\\/g, "/").toLowerCase();
  return resolved === self;
}
