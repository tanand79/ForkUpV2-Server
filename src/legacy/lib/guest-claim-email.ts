/**
 * Shared professional HTML + plain-text templates for guest claim emails
 * (NPO campaign claim + business profile claim).
 *
 * Purpose: Neat ForkUp-branded transactional mail. Callers pass context;
 * this module only renders subject/body/html — mailer sends.
 */
export type GuestClaimEmailKind = "business" | "campaign";

export type GuestClaimEmailInput = {
  kind: GuestClaimEmailKind;
  /** Business name or campaign name */
  entityName: string;
  claimUrl: string;
  /** Campaign public page — only used for kind=campaign */
  publicUrl?: string | null;
  expiresInDays: number;
};

export type RenderedGuestClaimEmail = {
  subject: string;
  body: string;
  html: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders subject, plain-text body, and HTML for a guest claim email.
 * Inputs: kind + entity name + URLs + TTL days.
 * Outputs: { subject, body, html }.
 */
export function renderGuestClaimEmail(
  input: GuestClaimEmailInput,
): RenderedGuestClaimEmail {
  const name = input.entityName.trim() || "your profile";
  const safeName = escapeHtml(name);
  const claimUrl = input.claimUrl.trim();
  const publicUrl =
    typeof input.publicUrl === "string" ? input.publicUrl.trim() : "";
  const days = Math.max(1, Math.floor(input.expiresInDays));

  const isBusiness = input.kind === "business";
  const entityLabel = isBusiness ? "business" : "campaign";
  const subject = isBusiness
    ? `Claim your business on ForkUp — ${name}`
    : `Claim your campaign on ForkUp — ${name}`;

  const headline = isBusiness
    ? "Your business is saved on ForkUp"
    : "Your campaign is live on ForkUp";
  const intro = isBusiness
    ? `Thanks for joining ForkUp. <strong>${safeName}</strong> has been saved as a business profile.`
    : `Thanks for launching on ForkUp. Your campaign <strong>${safeName}</strong> is live.`;
  const ctaLabel = isBusiness
    ? "Claim &amp; manage profile"
    : "Claim &amp; manage campaign";
  const actionLine = isBusiness
    ? "Use the button below to claim and manage this profile from any device."
    : "Use the button below to claim and manage this campaign from any device.";

  const bodyLines = [
    `Hi,`,
    ``,
    isBusiness
      ? `Your business "${name}" is saved on ForkUp.`
      : `Your campaign "${name}" is live on ForkUp.`,
  ];
  if (publicUrl) {
    bodyLines.push(``, `Public campaign page:`, publicUrl);
  }
  bodyLines.push(
    ``,
    `To claim and manage this ${entityLabel} from any device, open the link below:`,
    claimUrl,
    ``,
    `This secure link expires in ${days} days. Please do not forward it — anyone with the link can claim management of this ${entityLabel}.`,
    ``,
    `— The ForkUp Team`,
  );
  const body = bodyLines.join("\n");

  const publicBlockHtml = publicUrl
    ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#4b5563;">
         Public campaign page:<br />
         <a href="${escapeHtml(publicUrl)}" style="color:#b45309;word-break:break-all;">${escapeHtml(publicUrl)}</a>
       </p>`
    : "";

  const html = `<!DOCTYPE html>
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
            <td style="background-color:#1c1917;padding:22px 28px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;letter-spacing:0.04em;color:#fafaf9;">ForkUp</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
              <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:#1c1917;">${escapeHtml(headline)}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#374151;">${intro}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#4b5563;">${actionLine}</p>
              ${publicBlockHtml}
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:8px;background-color:#b45309;">
                    <a href="${escapeHtml(claimUrl)}" style="display:inline-block;padding:14px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${ctaLabel}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:12px;line-height:1.5;color:#9ca3af;word-break:break-all;">
                <a href="${escapeHtml(claimUrl)}" style="color:#b45309;">${escapeHtml(claimUrl)}</a>
              </p>
              <p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.55;color:#6b7280;">
                This secure link expires in <strong>${days} days</strong>. Please do not forward it — anyone with the link can claim management of this ${entityLabel}.
              </p>
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

  return { subject, body, html };
}
