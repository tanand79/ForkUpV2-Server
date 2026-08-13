# Changelog — mailer Reply-To / From display name

## 2026-08-13 — Added (append-only)

- Extended `SendEmailInput` with optional `replyTo` and `fromName`.
- When `campaignId` is set and those fields are omitted, mailer resolves nonprofit `contact_email` / `organization_name`.
- SMTP `From` address remains Super Admin `smtp_from`; display name may show the nonprofit; `Reply-To` set to nonprofit contact email.
- No existing routes, tables, or SMTP settings changed.

## 2026-08-13 — Platform sender for ForkUp review notice

- Added optional `platformSender` on `SendEmailInput` to skip nonprofit From/Reply-To enrichment.
- Set `platformSender: true` on `campaign_review_approved_live` so campaign review/live mail is From ForkUp admin SMTP only.
- Business/NPO trust verify emails were already admin-only (no `campaignId`); unchanged.

## 2026-08-13 — Global sender-party rules in mailer

- Added `EmailSenderParty` (`nonprofit` | `business` | `platform`) and optional `businessId` / `senderParty` on `SendEmailInput`.
- Global inference (unless explicit fromName/replyTo):
  - stakeholderRole `business` → nonprofit headers (NPO → business)
  - stakeholderRole `nonprofit` + `businessId` → business headers (business → NPO)
  - `platformSender` / otherwise → plain ForkUp admin smtp_from
- Wired accept/decline notify + business-initiated NPO invite with `senderParty: "business"` + `businessId`.
- Fundraiser→NPO invite uses platform + fundraiser fromName/replyTo (not campaign nonprofit).
