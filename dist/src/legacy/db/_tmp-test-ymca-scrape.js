"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const suggest_social_images_1 = require("../lib/suggest-social-images");
const business_venue_images_1 = require("../lib/business-venue-images");
const organization_ai_campaign_flow_1 = require("../lib/organization-ai-campaign-flow");
async function main() {
    const website = "https://www.rosesymca.org/";
    const social = await (0, suggest_social_images_1.discoverSocialLinksFromWebsite)(website);
    console.log("social", social);
    const meta = await (0, organization_ai_campaign_flow_1.extractOrgPageMeta)(website);
    console.log("meta", meta);
    const imgs = await (0, suggest_social_images_1.suggestSocialImages)({
        websiteUrl: website,
        facebookUrl: social.facebookUrl || "",
        instagramHandle: social.instagramUrl || "",
        youtubeUrl: social.youtubeUrl || "",
        limit: 10,
    });
    console.log("suggestSocialImages", imgs.length, imgs.slice(0, 4).map((i) => i.url));
    const venue = await (0, business_venue_images_1.scrapeBusinessVenueImages)({ websiteUrl: website, limit: 10 });
    console.log("venueImages", venue.length, venue.slice(0, 4));
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=_tmp-test-ymca-scrape.js.map