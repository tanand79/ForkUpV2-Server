export type JoinGivebackMode = "restaurant_dine_percent" | "percent_of_purchase" | "dollar_per_visit" | "special_offer";
export type JoinCauseMode = "pick_now" | "forkup_match";
export declare function normalizeJoinGivebackMode(raw: unknown): JoinGivebackMode | null;
export declare function normalizeJoinCauseMode(raw: unknown): JoinCauseMode | null;
export declare function normalizePreferredCampaignSlug(raw: unknown): string | null;
