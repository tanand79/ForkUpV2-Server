import type { JoinDoorType } from "./join-door-type";
export type ChecklistItemStatus = "done" | "needed" | "optional";
export type PostStartChecklistItem = {
    id: string;
    label: string;
    status: ChecklistItemStatus;
    when: "required" | "later";
    hint: string;
};
export type BusinessPostStartChecklistInput = {
    joinDoorType: JoinDoorType | null;
    businessName: string | null;
    contactEmail: string | null;
    claimStatus: string | null;
    profileStatus: string | null;
    locationCount: number;
    hasRealLocation: boolean;
    hasCapability: boolean;
    hasAchSetup: boolean;
    hasAcceptedCampaign: boolean;
};
export declare function buildBusinessPostStartChecklist(input: BusinessPostStartChecklistInput): {
    joinDoorType: JoinDoorType | null;
    required: PostStartChecklistItem[];
    later: PostStartChecklistItem[];
};
