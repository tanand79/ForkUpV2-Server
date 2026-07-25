-- ForkUp V1 Core Data Model
-- Campaign = parent container. Methods, businesses, and locations attach to campaigns.

-- ─── Profile System ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nonprofits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  logo_url VARCHAR(512) NULL,
  mission TEXT NULL,
  description TEXT NULL,
  website VARCHAR(512) NULL,
  contact_name VARCHAR(255) NULL,
  contact_email VARCHAR(255) NULL,
  contact_phone VARCHAR(50) NULL,
  cause_category VARCHAR(100) NULL,
  verification_status ENUM('unclaimed', 'claimed', 'verified', 'needs_review', 'archived') NOT NULL DEFAULT 'unclaimed',
  claim_status ENUM('unclaimed', 'claimed', 'verified', 'needs_review', 'archived') NOT NULL DEFAULT 'unclaimed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS businesses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  business_type VARCHAR(100) NULL,
  logo_url VARCHAR(512) NULL,
  description TEXT NULL,
  website VARCHAR(512) NULL,
  default_giveback_percentage DECIMAL(5,2) NULL,
  contact_name VARCHAR(255) NULL,
  contact_email VARCHAR(255) NULL,
  contact_phone VARCHAR(50) NULL,
  supports_dine_and_donate TINYINT(1) NOT NULL DEFAULT 0,
  supports_shop_and_donate TINYINT(1) NOT NULL DEFAULT 0,
  supports_service_giveback TINYINT(1) NOT NULL DEFAULT 0,
  supports_guest_bartending TINYINT(1) NOT NULL DEFAULT 0,
  supports_ambassador_tracking TINYINT(1) NOT NULL DEFAULT 0,
  business_status ENUM('preloaded', 'invited', 'claimed', 'active', 'archived') NOT NULL DEFAULT 'preloaded',
  claim_status ENUM('unclaimed', 'claimed', 'verified', 'needs_review', 'archived') NOT NULL DEFAULT 'unclaimed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  location_name VARCHAR(255) NOT NULL,
  address VARCHAR(255) NULL,
  city VARCHAR(100) NULL,
  state VARCHAR(50) NULL,
  zip VARCHAR(20) NULL,
  phone VARCHAR(50) NULL,
  website_url VARCHAR(512) NULL,
  reservation_url VARCHAR(512) NULL,
  booking_url VARCHAR(512) NULL,
  active_status TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_locations_business
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX idx_business_locations_business_id ON business_locations(business_id);

-- ─── Campaign Architecture ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(255) NOT NULL UNIQUE,
  nonprofit_id INT NOT NULL,
  campaign_name VARCHAR(255) NOT NULL,
  campaign_story TEXT NOT NULL,
  campaign_goal INT NOT NULL DEFAULT 0,
  campaign_start_date DATE NULL,
  campaign_end_date DATE NULL,
  campaign_status ENUM(
    'draft',
    'invitation_phase',
    'ready_to_launch',
    'live',
    'closed',
    'settlement'
  ) NOT NULL DEFAULT 'draft',
  cover_image_url VARCHAR(512) NOT NULL,
  logo_url VARCHAR(512) NULL,
  raised INT NOT NULL DEFAULT 0,
  supporters_going INT NOT NULL DEFAULT 0,
  expected_guests INT NOT NULL DEFAULT 0,
  verified_visits INT NOT NULL DEFAULT 0,
  top_event TINYINT(1) NOT NULL DEFAULT 0,
  terms_accepted TINYINT(1) NOT NULL DEFAULT 0,
  terms_accepted_at DATETIME NULL,
  invitation_deadline DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_campaigns_nonprofit
    FOREIGN KEY (nonprofit_id) REFERENCES nonprofits(id) ON DELETE RESTRICT
);

CREATE INDEX idx_campaigns_nonprofit_id ON campaigns(nonprofit_id);
CREATE INDEX idx_campaigns_status ON campaigns(campaign_status);

CREATE TABLE IF NOT EXISTS campaign_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_type ENUM(
    'dine_and_donate',
    'shop_and_donate',
    'service_giveback',
    'virtual_donations',
    'ambassador_fundraising',
    'guest_bartending_event'
  ) NOT NULL,
  method_name VARCHAR(255) NOT NULL,
  method_start_date DATE NULL,
  method_end_date DATE NULL,
  method_status ENUM(
    'draft',
    'invited',
    'pending_acceptance',
    'accepted',
    'scheduled',
    'live',
    'completed',
    'closed'
  ) NOT NULL DEFAULT 'draft',
  requires_business_acceptance TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_methods_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX idx_campaign_methods_campaign_id ON campaign_methods(campaign_id);

CREATE TABLE IF NOT EXISTS campaign_business_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_id INT NOT NULL,
  business_id INT NOT NULL,
  location_id INT NOT NULL,
  invite_status ENUM('invited', 'pending', 'accepted', 'declined', 'changes_requested', 'live', 'completed') NOT NULL DEFAULT 'invited',
  acceptance_status ENUM('invited', 'pending', 'accepted', 'declined', 'changes_requested', 'live', 'completed') NOT NULL DEFAULT 'invited',
  giveback_percentage DECIMAL(5,2) NOT NULL,
  participation_start_date DATE NULL,
  participation_end_date DATE NULL,
  participation_hours VARCHAR(255) NULL,
  eligible_sales_rules TEXT NULL,
  settlement_status ENUM('pending', 'in_progress', 'completed') NOT NULL DEFAULT 'pending',
  terms_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  ach_authorized TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cbl_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_cbl_method
    FOREIGN KEY (method_id) REFERENCES campaign_methods(id) ON DELETE CASCADE,
  CONSTRAINT fk_cbl_business
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cbl_location
    FOREIGN KEY (location_id) REFERENCES business_locations(id) ON DELETE RESTRICT
);

CREATE INDEX idx_cbl_campaign_id ON campaign_business_locations(campaign_id);
CREATE INDEX idx_cbl_method_id ON campaign_business_locations(method_id);

-- ─── Supporter Participation ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supporters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_supporters_email ON supporters(email);

CREATE TABLE IF NOT EXISTS participation_intents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_id INT NULL,
  business_id INT NULL,
  location_id INT NULL,
  supporter_id INT NOT NULL,
  party_size INT NOT NULL DEFAULT 1,
  is_first_visit TINYINT(1) NOT NULL DEFAULT 0,
  participation_path ENUM('reservation', 'walk_in') NOT NULL DEFAULT 'walk_in',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_intents_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_intents_supporter
    FOREIGN KEY (supporter_id) REFERENCES supporters(id) ON DELETE CASCADE
);

CREATE INDEX idx_participation_intents_campaign_id ON participation_intents(campaign_id);

-- ─── People-Powered Fundraising ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_participants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_id INT NULL,
  participant_type ENUM('ambassador', 'guest_bartender') NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL,
  role_label VARCHAR(100) NULL,
  status ENUM('invited', 'active', 'completed') NOT NULL DEFAULT 'invited',
  personal_share_link VARCHAR(512) NULL,
  tracking_code VARCHAR(100) NULL,
  leaderboard_enabled TINYINT(1) NOT NULL DEFAULT 1,
  business_id INT NULL,
  location_id INT NULL,
  event_date DATE NULL,
  event_start_time TIME NULL,
  event_end_time TIME NULL,
  attributed_donation_total INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_participants_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

-- ─── Receipt & Settlement (MVP migration targets) ────────────────────────────

CREATE TABLE IF NOT EXISTS receipts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  method_id INT NULL,
  business_id INT NULL,
  location_id INT NULL,
  supporter_id INT NULL,
  uploaded_image_url VARCHAR(512) NULL,
  ocr_status ENUM('uploaded', 'processing', 'needs_review', 'approved', 'rejected') NOT NULL DEFAULT 'uploaded',
  review_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  subtotal DECIMAL(10,2) NULL,
  eligible_subtotal DECIMAL(10,2) NULL,
  donation_percentage DECIMAL(5,2) NULL,
  calculated_donation DECIMAL(10,2) NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  CONSTRAINT fk_receipts_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settlements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  business_id INT NULL,
  location_id INT NULL,
  eligible_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
  donation_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  donation_pool DECIMAL(12,2) NOT NULL DEFAULT 0,
  forkup_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_nonprofit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_due_date DATE NULL,
  payment_status ENUM('pending', 'invoiced', 'paid') NOT NULL DEFAULT 'pending',
  report_generated_at DATETIME NULL,
  locked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_settlements_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

-- ─── Success Engine ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS success_engine_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  action_type ENUM(
    'launch_email',
    'one_week_reminder',
    'mid_campaign_reminder',
    'final_push_reminder',
    'results_email',
    'ambassador_recruitment',
    'guest_bartender_recruitment',
    'business_promotion',
    'receipt_reminder'
  ) NOT NULL,
  channel ENUM('email', 'text', 'social') NOT NULL DEFAULT 'email',
  scheduled_date DATE NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  status ENUM('scheduled', 'ready', 'completed') NOT NULL DEFAULT 'scheduled',
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_success_actions_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX idx_success_engine_campaign_id ON success_engine_actions(campaign_id);

-- ─── Business Invitation & Acceptance ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invitation_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_business_location_id INT NOT NULL UNIQUE,
  token VARCHAR(64) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tokens_cbl
    FOREIGN KEY (campaign_business_location_id) REFERENCES campaign_business_locations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS business_acceptances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_business_location_id INT NOT NULL UNIQUE,
  authorized_representative VARCHAR(255) NOT NULL,
  eligible_sales_rules TEXT NULL,
  forkup_fee_acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  net7_acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  ach_authorized TINYINT(1) NOT NULL DEFAULT 0,
  billing_contact_name VARCHAR(255) NULL,
  billing_contact_email VARCHAR(255) NULL,
  settlement_contact_name VARCHAR(255) NULL,
  settlement_contact_email VARCHAR(255) NULL,
  change_request_message TEXT NULL,
  decline_reason TEXT NULL,
  accepted_at DATETIME NULL,
  declined_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_acceptances_cbl
    FOREIGN KEY (campaign_business_location_id) REFERENCES campaign_business_locations(id) ON DELETE CASCADE
);

-- ─── Foundation: Users, Donations, Imports, Business Invitations ─────────────

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

CREATE TABLE IF NOT EXISTS organization_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_type ENUM('nonprofit', 'business') NOT NULL,
  organization_id INT NOT NULL,
  import_type ENUM(
    'csv', 'contacts', 'assets', 'pdf', 'url', 'campaign_history', 'integration'
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
