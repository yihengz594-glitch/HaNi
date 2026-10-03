-- Additive credit products, server-side generation settlement, and secure admin/code management.
-- Requires migrations 001-004. Back up production data before applying. No legacy product/order rows are rewritten.
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credits_reserved INTEGER NOT NULL DEFAULT 0 CHECK (credits_reserved >= 0),
  ADD COLUMN IF NOT EXISTS permanent_entitlement BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(64),
  ADD COLUMN IF NOT EXISTS product_type_snapshot VARCHAR(20),
  ADD COLUMN IF NOT EXISTS duration_days_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS credit_amount_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS permanent_snapshot BOOLEAN,
  ADD COLUMN IF NOT EXISTS benefits_json_snapshot TEXT;

ALTER TABLE membership_redeem_codes
  ADD COLUMN IF NOT EXISTS batch_id VARCHAR(36);

CREATE TABLE IF NOT EXISTS generation_tasks (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  feature VARCHAR(24) NOT NULL DEFAULT 'PATTERN',
  status VARCHAR(16) NOT NULL CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  billing_mode VARCHAR(16) NOT NULL CHECK (billing_mode IN ('CREDITS', 'MEMBERSHIP', 'PERMANENT')),
  credit_cost INTEGER NOT NULL DEFAULT 0 CHECK (credit_cost >= 0),
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  settings_json JSONB NOT NULL,
  result_json JSONB,
  error_code VARCHAR(48),
  lease_until TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS generation_tasks_user_created_idx ON generation_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_tasks_recovery_idx ON generation_tasks (status, lease_until);

CREATE TABLE IF NOT EXISTS generation_task_events (
  id VARCHAR(36) PRIMARY KEY,
  task_id VARCHAR(36) NOT NULL REFERENCES generation_tasks(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(24) NOT NULL,
  credit_delta INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS generation_task_events_user_created_idx ON generation_task_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_redeem_batches (
  id VARCHAR(36) PRIMARY KEY,
  plan_id VARCHAR(32) NOT NULL REFERENCES membership_plans(id),
  created_by VARCHAR(64) NOT NULL,
  note VARCHAR(240) NOT NULL DEFAULT '',
  expires_at TIMESTAMP,
  code_count INTEGER NOT NULL CHECK (code_count BETWEEN 1 AND 500),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS membership_redeem_batches_created_idx ON membership_redeem_batches (created_at DESC);
DO $$ BEGIN
  ALTER TABLE membership_redeem_codes ADD CONSTRAINT membership_redeem_codes_batch_fk
    FOREIGN KEY (batch_id) REFERENCES membership_redeem_batches(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS membership_redeem_codes_batch_idx ON membership_redeem_codes (batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS redeem_requests (
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(128) NOT NULL,
  code_hash VARCHAR(128) NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS redeem_attempts (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS redeem_attempts_user_idx ON redeem_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS redeem_attempts_source_idx ON redeem_attempts (source_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(256) NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id VARCHAR(36) PRIMARY KEY,
  identity_hash VARCHAR(64) NOT NULL,
  succeeded BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_identity_idx ON admin_login_attempts (identity_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id VARCHAR(36) PRIMARY KEY,
  admin_id VARCHAR(36) REFERENCES admin_users(id),
  event_type VARCHAR(48) NOT NULL,
  target_id VARCHAR(64),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx ON admin_audit_events (created_at DESC);

-- Versioned IDs preserve existing orders, memberships, redemption codes and balances.
-- Disable only legacy offers: active memberships and already-created orders remain valid.
UPDATE membership_plans
   SET enabled = FALSE, updated_at = NOW()
 WHERE id IN ('day', 'week', 'month', 'year', 'credits10', 'credits30', 'credits100');

INSERT INTO membership_plans
  (id, name, duration_days, amount_fen, original_amount_fen, benefits_json, sort_order,
   enabled, created_at, updated_at, product_type, credit_amount)
VALUES
  ('credits10_v2', '10次卡', 0, 888, NULL, '["拼豆图纸生成10次","不限有效期"]', 10, TRUE, NOW(), NOW(), 'CREDITS', 10),
  ('credits30_v2', '30次卡', 0, 1888, NULL, '["拼豆图纸生成30次","不限有效期"]', 20, TRUE, NOW(), NOW(), 'CREDITS', 30),
  ('credits100_v2', '100次卡', 0, 6666, NULL, '["拼豆图纸生成100次","不限有效期"]', 30, TRUE, NOW(), NOW(), 'CREDITS', 100),
  ('permanent_v1', '永久卡', 0, 8888, NULL, '["永久权益","生成不限次数"]', 40, TRUE, NOW(), NOW(), 'PERMANENT', 0)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Rollback guidance (only after stopping app traffic and checking that no new orders/codes/tasks exist):
-- Do not drop new product rows if they have orders or redeemed codes. Disable them instead.
-- The additive tables/columns may be removed only after exporting their audit/history data and
-- returning all in-flight task reservations to users. Never roll back by deleting user balances.
