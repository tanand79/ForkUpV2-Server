/**
 * Pass C2 — normalize Join Us business door type.
 * Purpose: Validate optional joinDoorType from claim/onboarding bodies.
 * Inputs: unknown body field. Outputs: 'restaurant' | 'local' | null.
 */
export type JoinDoorType = "restaurant" | "local";

export function normalizeJoinDoorType(raw: unknown): JoinDoorType | null {
  if (raw === "restaurant" || raw === "local") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "restaurant" || v === "local") return v;
  }
  return null;
}
