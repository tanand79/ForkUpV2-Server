export declare function normalizeFeaturedYouTubeVideoUrl(url: string | null | undefined): string | null;
export type FeaturedYoutubeBodyParse = {
    ok: true;
    value: string | null | undefined;
} | {
    ok: false;
    error: string;
};
export declare function parseFeaturedYoutubeFromBody(body: {
    featuredYoutubeUrl?: string | null;
}): FeaturedYoutubeBodyParse;
