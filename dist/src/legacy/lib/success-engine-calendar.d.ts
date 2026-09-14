import type { MethodType } from "../types/campaign";
export type CalendarDraftAction = {
    action_type: string;
    channel: "email" | "text" | "social";
    scheduled_date: string;
    title: string;
    content: string;
    stakeholder_role: "nonprofit" | "business" | "ambassador" | "supporter" | "admin";
    generated_by: "system" | "ai";
};
export declare function buildSuccessEngineCalendar(input: {
    campaignName: string;
    methods: MethodType[];
    startDate?: string | null;
    eventDate?: string | null;
    endDate?: string | null;
    nonprofitName?: string;
    hasAcceptedBusiness?: boolean;
}): CalendarDraftAction[];
