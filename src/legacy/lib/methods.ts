import type { MethodType } from "../types/campaign";

export const METHOD_LABELS: Record<MethodType, string> = {
  dine_and_donate: "Dine & Donate",
  shop_and_donate: "Shop & Donate",
  service_giveback: "Service Giveback",
  virtual_donations: "Virtual Donations",
  ambassador_fundraising: "Ambassador Fundraising",
  guest_bartending_event: "Guest Bartender",
};

export const METHOD_REQUIRES_BUSINESS: Record<MethodType, boolean> = {
  dine_and_donate: true,
  shop_and_donate: true,
  service_giveback: true,
  virtual_donations: false,
  ambassador_fundraising: false,
  guest_bartending_event: true,
};

export const METHOD_CAPABILITY: Record<MethodType, string> = {
  dine_and_donate: "supports_dine_and_donate",
  shop_and_donate: "supports_shop_and_donate",
  service_giveback: "supports_service_giveback",
  virtual_donations: "supports_ambassador_tracking",
  ambassador_fundraising: "supports_ambassador_tracking",
  guest_bartending_event: "supports_guest_bartending",
};

export function requiresAnyBusiness(methods: MethodType[]): boolean {
  return methods.some((m) => METHOD_REQUIRES_BUSINESS[m]);
}
