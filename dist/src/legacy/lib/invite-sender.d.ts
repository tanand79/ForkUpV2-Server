import type { PoolClient } from "pg";
export type OrganizationType = "nonprofit" | "business";
export type OrgMemberPerson = {
    userId: number;
    fullName: string;
    email: string;
    role: string;
};
export type InviteSenderHeaders = {
    fromName: string;
    replyTo: string;
    userId: number;
};
export declare function parseInviteFromName(value: unknown): string | null;
export declare function listOrganizationMembers(organizationType: OrganizationType, organizationId: number, client?: PoolClient): Promise<OrgMemberPerson[]>;
export declare function resolveOrgMemberSender(organizationType: OrganizationType, organizationId: number, senderUserId: number, client?: PoolClient): Promise<InviteSenderHeaders | null>;
export declare function loadCampaignInviteSender(campaignId: number, client?: PoolClient): Promise<InviteSenderHeaders | null>;
export declare function setCampaignInviteSenderUserId(campaignId: number, senderUserId: number | null, client?: PoolClient): Promise<void>;
export declare function setCampaignInviteFromName(campaignId: number, fromName: string | null, client?: PoolClient): Promise<void>;
export declare function parseSenderUserId(value: unknown): number | null;
export declare function resolveUserSender(userId: number, client?: PoolClient): Promise<InviteSenderHeaders | null>;
