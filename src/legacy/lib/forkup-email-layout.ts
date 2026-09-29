/**
 * Shared ForkUp transactional email HTML shell.
 *
 * Purpose: Wrap plain-text email bodies (templates, invites, system mail)
 * in the same branded layout as guest claim emails — white ForkUp header
 * with logo, white card, orange CTA when a link is present.
 * Does not send mail — callers / mailer pass the returned HTML.
 *
 * When a CTA URL is extracted, that URL is removed from the body so the
 * button / copy-link block is the only place the link appears.
 *
 * Logo: default src is cid:FORKUP_EMAIL_LOGO_CID (mailer attaches the PNG).
 * Override with EMAIL_LOGO_URL (https) when you prefer a hosted image.
 */

import * as fs from "fs";
import * as path from "path";

function urlPattern(): RegExp {
  return /https?:\/\/[^\s<>"']+/gi;
}

/** Content-ID used by mailer SMTP inline attachment + &lt;img src="cid:…"&gt;. */
export const FORKUP_EMAIL_LOGO_CID = "forkup-logo@forkup";

export type ForkUpEmailLayoutInput = {
  subject: string;
  bodyText: string;
  /** Optional headline; defaults to subject. */
  headline?: string | null;
  /** Optional CTA label when a URL is found. Default: "Open link" */
  ctaLabel?: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Logo src for email HTML. Prefer EMAIL_LOGO_URL; else CID for SMTP attach.
 */
export function resolveEmailLogoUrl(): string {
  const explicit = (process.env.EMAIL_LOGO_URL ?? "").trim();
  if (explicit) return explicit;
  return `cid:${FORKUP_EMAIL_LOGO_CID}`;
}

/**
 * Loads the ForkUp email logo PNG from dist or src assets.
 * Outputs: Buffer or null when the file is missing.
 */
export function loadForkUpEmailLogoBuffer(): Buffer | null {
  const candidates = [
    // nest-cli copies assets to dist/legacy/assets (not under dist/src)
    path.join(process.cwd(), "dist", "legacy", "assets", "forkup-logo-email.png"),
    path.join(process.cwd(), "src", "legacy", "assets", "forkup-logo-email.png"),
    path.join(__dirname, "..", "..", "..", "legacy", "assets", "forkup-logo-email.png"),
    path.join(__dirname, "..", "assets", "forkup-logo-email.png"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Header cell HTML with ForkUp logo on a white bar (shared by layout + guest claim).
 * Outputs: &lt;td&gt;…&lt;/td&gt; fragment for the branded email header row.
 */
export function forkUpEmailHeaderCellHtml(): string {
  const logoUrl = escapeHtml(resolveEmailLogoUrl());
  return `<td style="background-color:#ffffff;padding:18px 28px;border-bottom:1px solid #e5e7eb;">
              <img src="${logoUrl}" alt="ForkUp" width="140" height="48" style="display:block;height:48px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;" />
            </td>`;
}

/**
 * Finds the first http(s) URL in plain text (for CTA button).
 * Inputs: body text. Outputs: URL string or null.
 */
export function firstUrlInText(text: string): string | null {
  const m = text.match(urlPattern());
  if (!m || !m[0]) return null;
  return m[0].replace(/[.,);]+$/g, "");
}

/**
 * Escapes plain text and turns URLs into orange links (href from raw URL).
 * Inputs: one line of plain text. Outputs: safe HTML fragment.
 */
function linkifyLine(text: string): string {
  const re = urlPattern();
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const raw = m[0];
    const href = raw.replace(/[.,);]+$/g, "");
    const trailing = raw.slice(href.length);
    out +=
      `<a href="${escapeHtml(href)}" style="color:#b45309;word-break:break-all;">` +
      `${escapeHtml(href)}</a>${escapeHtml(trailing)}`;
    last = m.index + raw.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * When CTA owns the primary URL, strip it (and redundant prompt/sign-off lines)
 * from the body so the link is not shown twice.
 */
function prepareBodyForLayout(bodyText: string, ctaUrl: string | null): string {
  let t = bodyText.replace(/\r\n/g, "\n");
  if (ctaUrl) {
    t = t.split(ctaUrl).join("");
    t = t
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/^review and respond here:?$/i.test(trimmed)) return false;
        if (/^(to )?(claim|open|view|manage).{0,40}(here|below|link):?$/i.test(trimmed))
          return false;
        if (/^(or )?copy this link/i.test(trimmed)) return false;
        if (/^[—\-–]+\s*the\s+forkup\s+team\s*$/i.test(trimmed)) return false;
        if (/^[—\-–]+\s*forkup\s*$/i.test(trimmed)) return false;
        return true;
      })
      .join("\n");
  }
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Converts plain-text body into paragraph HTML (preserves blank-line breaks).
 * Inputs: body text. Outputs: HTML fragment of <p> blocks.
 */
function bodyTextToHtml(bodyText: string): string {
  const normalized = bodyText.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const blocks = normalized.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block
        .split("\n")
        .map((line) => linkifyLine(line))
        .filter((line) => line.trim().length > 0);
      if (lines.length === 0) return "";
      const inner = lines.join("<br />\n");
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#374151;">${inner}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Wraps subject + plain body in the ForkUp branded HTML email layout.
 * Inputs: subject, bodyText, optional headline/ctaLabel.
 * Outputs: full HTML document string.
 */
export function wrapForkUpEmailHtml(input: ForkUpEmailLayoutInput): string {
  const subject = (input.subject || "").trim() || "ForkUp";
  const headline =
    (typeof input.headline === "string" && input.headline.trim()) || subject;
  const rawBody = typeof input.bodyText === "string" ? input.bodyText : "";
  const ctaUrl = firstUrlInText(rawBody);
  const ctaLabelRaw =
    (typeof input.ctaLabel === "string" && input.ctaLabel.trim()) || "Open link";
  const ctaLabel = escapeHtml(ctaLabelRaw);

  const bodyHtml = bodyTextToHtml(prepareBodyForLayout(rawBody, ctaUrl));

  const ctaBlock = ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 28px;">
                <tr>
                  <td style="border-radius:8px;background-color:#b45309;">
                    <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:14px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${ctaLabel}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:12px;line-height:1.5;color:#9ca3af;word-break:break-all;">
                <a href="${escapeHtml(ctaUrl)}" style="color:#b45309;">${escapeHtml(ctaUrl)}</a>
              </p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            ${forkUpEmailHeaderCellHtml()}
          </tr>
          <tr>
            <td style="padding:32px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:#1c1917;">${escapeHtml(headline)}</h1>
              ${bodyHtml}
              ${ctaBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9ca3af;">
              — The ForkUp Team
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
