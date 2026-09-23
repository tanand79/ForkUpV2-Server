/**
 * GET /api/venue-photo-proxy?url=…
 *
 * Purpose: Re-host Resy CDN bytes through our API so the browser gallery can
 * show image.resy.com photos (same-origin /api). Allow-listed hosts only.
 */
import { Router } from "express";

export const venuePhotoProxyRouter = Router();

const ALLOWED_HOSTS = /^(image\.resy\.com|images\.resy\.com)$/i;
const FETCH_MS = 12_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

venuePhotoProxyRouter.get("/venue-photo-proxy", async (req, res) => {
  try {
    const raw = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!raw || !/^https?:\/\//i.test(raw)) {
      res.status(400).json({ error: "url query param required" });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      res.status(400).json({ error: "invalid url" });
      return;
    }
    if (!ALLOWED_HOSTS.test(parsed.hostname)) {
      res.status(400).json({ error: "host not allowed" });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_MS);
    try {
      const upstream = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: "https://resy.com/",
          Origin: "https://resy.com",
        },
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: "upstream image failed" });
        return;
      }
      const contentType =
        upstream.headers.get("content-type")?.split(";")[0]?.trim() ||
        "image/jpeg";
      if (!contentType.startsWith("image/")) {
        res.status(502).json({ error: "upstream was not an image" });
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(buf);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "proxy failed" });
  }
});
