#!/bin/bash
# Additive schema sync for RDS forkupv2 — no seed.
set -euo pipefail
cd ~/ForkUpV2-Server
unset DATABASE_URL_PRODUCTION URL_PG URL_NEW URL_FK NODE_TLS_REJECT_UNAUTHORIZED
export NODE_ENV=production
export DATABASE_TARGET=production
export DB_SSL_REJECT_UNAUTHORIZED=false

echo "TARGET=$(grep '^DATABASE_URL_PRODUCTION=' .env | sed -E 's#://[^@]+@#://****@#')"

run() {
  echo ""
  echo "==== $1 ===="
  npm run "$1"
}

# Core already applied earlier; re-run safe IF NOT EXISTS migrations
run db:migrate
run db:foundation
run db:superadmin
run db:settlement-engine
run db:settlement-parity
run db:settlement-ach-flow
run db:automation
run db:email
run db:email-smtp-provider
run db:email-related-token-width
run db:library
run db:payouts
run db:campaign-images
run db:cover-image-url-width
run db:featured-youtube-url
run db:campaign-images-url-width
run db:campaign-timing
run db:timeline-bands
run db:campaign-in-review
run db:forkup-review-changes-requested
run db:business-invite-lifecycle
run db:business-invite-status-fields
run db:campaign-ai
run db:ai-campaign-flow
run db:fundraiser-invites
run db:guest-campaign-claim
run db:guest-fundraiser-invite
run db:geo-coordinates
run db:user-ai-settings
run db:staff-product-email-split

# Scripts without dedicated npm aliases
echo ""
echo "==== migrate-location-ach ===="
npx tsx src/legacy/db/migrate-location-ach.ts
echo "==== migrate-receipt-ocr ===="
npx tsx src/legacy/db/migrate-receipt-ocr.ts
echo "==== migrate-pending-signups ===="
npx tsx src/legacy/db/migrate-pending-signups.ts
echo "==== migrate-email-verification ===="
npx tsx src/legacy/db/migrate-email-verification.ts
echo "==== migrate-password-reset-code ===="
npx tsx src/legacy/db/migrate-password-reset-code.ts
echo "==== migrate-verification-denied ===="
npx tsx src/legacy/db/migrate-verification-denied.ts || true

pm2 restart forkup-api --update-env || true
echo "SCHEMA_SYNC_DONE"
