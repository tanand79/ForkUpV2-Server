export type OAuthProvider = "google" | "apple";
export type VerifiedOAuthIdentity = {
    provider: OAuthProvider;
    subject: string;
    email: string;
    fullName: string | null;
};
export declare function verifyOAuthIdToken(provider: OAuthProvider, idToken: string): Promise<VerifiedOAuthIdentity>;
