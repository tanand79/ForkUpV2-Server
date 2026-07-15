-- Run after copying MySQL rows into PostgreSQL with their existing IDs.
-- Advances each identity sequence so future inserts cannot reuse imported IDs.

SELECT setval(pg_get_serial_sequence('nonprofits', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM nonprofits;
SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM businesses;
SELECT setval(pg_get_serial_sequence('business_locations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM business_locations;
SELECT setval(pg_get_serial_sequence('campaigns', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM campaigns;
SELECT setval(pg_get_serial_sequence('campaign_methods', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM campaign_methods;
SELECT setval(pg_get_serial_sequence('campaign_business_locations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM campaign_business_locations;
SELECT setval(pg_get_serial_sequence('supporters', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM supporters;
SELECT setval(pg_get_serial_sequence('participation_intents', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM participation_intents;
SELECT setval(pg_get_serial_sequence('campaign_participants', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM campaign_participants;
SELECT setval(pg_get_serial_sequence('receipts', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM receipts;
SELECT setval(pg_get_serial_sequence('settlements', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM settlements;
SELECT setval(pg_get_serial_sequence('success_engine_actions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM success_engine_actions;
SELECT setval(pg_get_serial_sequence('invitation_tokens', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM invitation_tokens;
SELECT setval(pg_get_serial_sequence('business_acceptances', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM business_acceptances;
SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM users;
SELECT setval(pg_get_serial_sequence('organization_users', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM organization_users;
SELECT setval(pg_get_serial_sequence('donations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM donations;
SELECT setval(pg_get_serial_sequence('organization_imports', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM organization_imports;
SELECT setval(pg_get_serial_sequence('business_invitations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM business_invitations;
SELECT setval(pg_get_serial_sequence('auth_sessions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM auth_sessions;
SELECT setval(pg_get_serial_sequence('nonprofit_campaign_invitations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM nonprofit_campaign_invitations;
