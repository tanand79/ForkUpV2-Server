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
