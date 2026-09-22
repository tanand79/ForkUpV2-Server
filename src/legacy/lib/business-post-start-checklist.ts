/**
 * Pass C2 — post-start checklist for business Join Us flow.
 * Purpose: Derive required-before-partner-ready vs later items from existing DB fields.
 * Inputs: business row + locations + ACH / invite flags.
 * Outputs: checklist payload for GET post-start-checklist (no new status enums).
 */
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

/**
 * Build required / later checklist rows from existing business state.
 */
export function buildBusinessPostStartChecklist(
  input: BusinessPostStartChecklistInput,
): {
  joinDoorType: JoinDoorType | null;
  required: PostStartChecklistItem[];
  later: PostStartChecklistItem[];
} {
  const role =
    input.joinDoorType === "restaurant" ? "restaurant" : "business";

  const profileDone =
    Boolean(input.businessName?.trim()) &&
    Boolean(input.contactEmail?.includes("@")) &&
    input.locationCount > 0 &&
    input.hasRealLocation;

  const verificationNeeded = input.claimStatus === "needs_review";
  const verificationDone =
    input.claimStatus === "verified" || input.claimStatus === "claimed";

  const required: PostStartChecklistItem[] = [
    {
      id: "profile_basics",
      label: `Complete ${role} profile basics`,
      status: profileDone ? "done" : "needed",
      when: "required",
      hint: "Name, contact email, and at least one real location.",
    },
    {
      id: "verification",
      label: "Verification",
      status: verificationNeeded ? "needed" : verificationDone ? "done" : "needed",
      when: "required",
      hint: verificationNeeded
        ? "ForkUp is reviewing your profile claim."
        : "Claimed or verified profile before partnering on campaigns.",
    },
    {
      id: "capabilities",
      label: "Confirm giveback capabilities",
      status: input.hasCapability ? "done" : "needed",
      when: "required",
      hint: "Dine & Donate, Shop & Donate, or other methods you support.",
    },
  ];

  const later: PostStartChecklistItem[] = [
    {
      id: "ach_setup",
      label: "ACH / settlement banking",
      status: input.hasAchSetup ? "done" : "optional",
      when: "later",
      hint: "Needed before settlement — can finish after your first partnership.",
    },
    {
      id: "campaign_accept",
      label: "Accept or join a campaign",
      status: input.hasAcceptedCampaign ? "done" : "optional",
      when: "later",
      hint: "Respond to nonprofit invitations when you are ready.",
    },
  ];

  return { joinDoorType: input.joinDoorType, required, later };
}
