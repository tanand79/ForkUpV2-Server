-- ForkUp V1 Foundation Extension
-- Users, multi-org access, profile fields, donations, organizational memory imports.
-- Applied via migrate-foundation.ts (safe for existing databases).

-- ─── Users & Organization Access ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  full_name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_type ENUM('nonprofit', 'business') NOT NULL,
  organization_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('owner', 'admin', 'manager', 'viewer') NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_user (organization_type, organization_id, user_id),
  CONSTRAINT fk_org_users_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_org_users_org ON organization_users (organization_type, organization_id);

-- ─── Donations (virtual, manual, offline adjustments) ────────────────────────

CREATE TABLE IF NOT EXISTS donations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_id INT NULL,
  supporter_id INT NULL,
  campaign_participant_id INT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  donation_type ENUM('virtual', 'manual', 'offline_adjustment') NOT NULL DEFAULT 'virtual',
  payment_status ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  attribution_code VARCHAR(100) NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_donations_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX idx_donations_campaign_id ON donations (campaign_id);

-- ─── Organizational Memory (import foundation) ───────────────────────────────

CREATE TABLE IF NOT EXISTS organization_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_type ENUM('nonprofit', 'business') NOT NULL,
  organization_id INT NOT NULL,
  import_type ENUM(
    'csv',
    'contacts',
    'assets',
    'pdf',
    'url',
    'campaign_history',
    'integration'
  ) NOT NULL,
  source_label VARCHAR(255) NULL,
  review_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  payload_json JSON NULL,
  campaign_id INT NULL,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_org_imports_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE INDEX idx_org_imports_org ON organization_imports (organization_type, organization_id);

-- ─── Business invitation log (minimal nonprofit invite: name + email) ─────────

CREATE TABLE IF NOT EXISTS business_invitations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  nonprofit_id INT NOT NULL,
  method_id INT NOT NULL,
  business_name VARCHAR(255) NOT NULL,
  business_email VARCHAR(255) NOT NULL,
  invitation_status ENUM('sent', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'sent',
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  campaign_business_location_id INT NULL,
  CONSTRAINT fk_bi_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_nonprofit FOREIGN KEY (nonprofit_id) REFERENCES nonprofits(id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_method FOREIGN KEY (method_id) REFERENCES campaign_methods(id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_cbl FOREIGN KEY (campaign_business_location_id) REFERENCES campaign_business_locations(id) ON DELETE SET NULL
);

CREATE INDEX idx_business_invitations_campaign ON business_invitations (campaign_id);

-- ─── Auth sessions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);

-- ─── Business-initiated nonprofit campaign invites ───────────────────────────

CREATE TABLE IF NOT EXISTS nonprofit_campaign_invitations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  business_id INT NOT NULL,
  location_id INT NOT NULL,
  nonprofit_id INT NOT NULL,
  campaign_id INT NOT NULL,
  method_id INT NOT NULL,
  method_type ENUM(
    'dine_and_donate',
    'shop_and_donate',
    'service_giveback',
    'guest_bartending_event'
  ) NOT NULL,
  giveback_percentage DECIMAL(5,2) NOT NULL DEFAULT 10,
  invitation_status ENUM('pending', 'accepted', 'declined') NOT NULL DEFAULT 'pending',
  message TEXT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  CONSTRAINT fk_nci_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_nci_location FOREIGN KEY (location_id) REFERENCES business_locations(id) ON DELETE CASCADE,
  CONSTRAINT fk_nci_nonprofit FOREIGN KEY (nonprofit_id) REFERENCES nonprofits(id) ON DELETE CASCADE,
  CONSTRAINT fk_nci_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_nci_method FOREIGN KEY (method_id) REFERENCES campaign_methods(id) ON DELETE CASCADE
);

CREATE INDEX idx_nci_nonprofit ON nonprofit_campaign_invitations (nonprofit_id, invitation_status);
