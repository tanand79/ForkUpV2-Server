import {
  discoverSocialLinksFromWebsite,
  suggestSocialImages,
} from "../lib/suggest-social-images";
import { scrapeBusinessVenueImages } from "../lib/business-venue-images";
import { extractOrgPageMeta } from "../lib/organization-ai-campaign-flow";

async function main() {
  const website = "https://www.rosesymca.org/";
  const social = await discoverSocialLinksFromWebsite(website);
  console.log("social", social);
  const meta = await extractOrgPageMeta(website);
  console.log("meta", meta);
  const imgs = await suggestSocialImages({
    websiteUrl: website,
    facebookUrl: social.facebookUrl || "",
    instagramHandle: social.instagramUrl || "",
    youtubeUrl: social.youtubeUrl || "",
    limit: 10,
  });
  console.log(
    "suggestSocialImages",
    imgs.length,
    imgs.slice(0, 4).map((i) => i.url),
  );
  const venue = await scrapeBusinessVenueImages({ websiteUrl: website, limit: 10 });
  console.log("venueImages", venue.length, venue.slice(0, 4));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
