"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildBusinessPostStartChecklist = buildBusinessPostStartChecklist;
function buildBusinessPostStartChecklist(input) {
    const role = input.joinDoorType === "restaurant" ? "restaurant" : "business";
    const profileDone = Boolean(input.businessName?.trim()) &&
        Boolean(input.contactEmail?.includes("@")) &&
        input.locationCount > 0 &&
        input.hasRealLocation;
    const verificationNeeded = input.claimStatus === "needs_review";
    const verificationDone = input.claimStatus === "verified" || input.claimStatus === "claimed";
    const required = [
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
    const later = [
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
        {
            id: "success_engine",
            label: "Success Engine & deeper setup",
            status: "optional",
            when: "later",
            hint: "Messaging, reminders, and full dashboard tools after you start.",
        },
    ];
    return { joinDoorType: input.joinDoorType, required, later };
}
//# sourceMappingURL=business-post-start-checklist.js.map