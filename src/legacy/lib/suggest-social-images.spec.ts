import { extractSocialLinksFromHtml } from "./suggest-social-images";

describe("extractSocialLinksFromHtml", () => {
  it("reads social profile URLs embedded in JSON and data attributes", () => {
    const html = `
      <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexample.org">Share</a>
      <a data-href="https://www.facebook.com/headtohead">Facebook</a>
      <script>{"instagram":"https:\\/\\/www.instagram.com\\/headtohead\\/"}</script>
      <a href="//www.linkedin.com/company/head-to-head">LinkedIn</a>
      <a href="https://www.youtube.com/watch?v=abc123">Video</a>
      <a href="https://www.youtube.com/@headtohead">Channel</a>
      <a href="https://www.tiktok.com/@headtohead">TikTok</a>
    `;
    const found = extractSocialLinksFromHtml(html);
    expect(found.facebookUrl).toBe("https://www.facebook.com/headtohead");
    expect(found.instagramUrl).toBe("https://www.instagram.com/headtohead/");
    expect(found.linkedinUrl).toBe("https://www.linkedin.com/company/head-to-head");
    expect(found.youtubeUrl).toBe("https://www.youtube.com/@headtohead");
    expect(found.tiktokUrl).toBe("https://www.tiktok.com/@headtohead");
  });

  it("does not treat a post or share link as the profile", () => {
    const html = `
      <a href="https://www.instagram.com/p/ABC123/">post</a>
      <a href="https://www.facebook.com/sharer.php?u=https%3A%2F%2Fexample.org">share</a>
    `;
    const found = extractSocialLinksFromHtml(html);
    expect(found.instagramUrl).toBeNull();
    expect(found.facebookUrl).toBeNull();
  });
});
