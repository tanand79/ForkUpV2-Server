export type CampaignStatus = "draft" | "in_review" | "invitation_phase" | "ready_to_launch" | "live" | "closed" | "settlement";
export type MethodType = "dine_and_donate" | "shop_and_donate" | "service_giveback" | "virtual_donations" | "ambassador_fundraising" | "guest_bartending_event";
export type ParticipationCta = "reserve" | "visit" | "shop" | "book" | "attend";
export interface CampaignMethod {
    id: number;
    methodType: MethodType;
    methodName: string;
    methodStatus: string;
    requiresBusinessAcceptance: boolean;
}
export interface ParticipatingLocation {
    businessId: number;
    locationId: number;
    methodId: number;
    businessName: string;
    businessType: string;
    locationName: string;
    city: string;
    state: string;
    givebackPercentage: number;
    participationHours: string | null;
    participationMethod: string;
    cta: ParticipationCta;
    reservationUrl: string | null;
    acceptanceStatus: string;
    website?: string | null;
    description?: string | null;
    logoUrl?: string | null;
    address?: string | null;
    zip?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    linkedinUrl?: string | null;
    tiktokUrl?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    galleryImageUrls?: string[];
}
export interface ParticipationRequest {
    firstName: string;
    email: string;
    partySize: number;
    isFirstVisit: boolean;
    businessId: number;
    locationId: number;
    methodId: number;
}
export interface ParticipationResponse {
    success: boolean;
    participationPath: "reservation" | "walk_in";
    reservationUrl: string | null;
    businessName: string;
    locationName: string;
    supportersGoing: number;
    expectedGuests: number;
}
export interface CampaignListItem {
    slug: string;
    name: string;
    nonprofit: string;
    nonprofitVerified: boolean;
    image: string;
    dateRange: string;
    startDate?: string | null;
    endDate?: string | null;
    raised: number;
    goal: number;
    supportersGoing: number;
    expectedGuests: number;
    verifiedVisits: number;
    topEvent: boolean;
    campaignStatus: CampaignStatus;
    participatingLocationCount: number;
}
export interface CampaignDetail extends CampaignListItem {
    description: string;
    methods: CampaignMethod[];
    participatingLocations: ParticipatingLocation[];
    eventDate: string | null;
    featuredYoutubeUrl: string | null;
}
