-- 人工真人转 Q 版工单。仅增表；生产执行前必须先备份数据库并取得运营确认。
BEGIN;

CREATE TABLE IF NOT EXISTS custom_access (
  user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id),
  is_merchant BOOLEAN NOT NULL DEFAULT FALSE,
  is_tester BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by VARCHAR(36) REFERENCES admin_users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_files (
  id VARCHAR(36) PRIMARY KEY,
  owner_id VARCHAR(36) NOT NULL REFERENCES users(id),
  order_id VARCHAR(36),
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('SOURCE','CHAT','Q_PREVIEW','Q_FINAL','PATTERN','COLORS')),
  storage_key VARCHAR(80) NOT NULL UNIQUE,
  mime_type VARCHAR(24) NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 15728640),
  sha256 VARCHAR(64) NOT NULL,
  state VARCHAR(12) NOT NULL DEFAULT 'STAGED' CHECK (state IN ('STAGED','VISIBLE','DELETED')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS custom_files_order_idx ON custom_files (order_id, created_at);
CREATE INDEX IF NOT EXISTS custom_files_expiry_idx ON custom_files (state, expires_at);

CREATE TABLE IF NOT EXISTS custom_orders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  requirements_json JSONB NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('PENDING_ACCEPT','IN_PROGRESS','WAIT_Q_CONFIRM','REVISION','WAIT_DELIVERY','COMPLETED','CANCELLED','REJECTED','SYSTEM_FAILED')),
  billing_mode VARCHAR(16) NOT NULL CHECK (billing_mode IN ('CREDITS','TEST_NO_CHARGE')),
  credit_cost INTEGER NOT NULL CHECK (credit_cost >= 0),
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  settled_credits INTEGER NOT NULL DEFAULT 0 CHECK (settled_credits >= 0),
  refunded_credits INTEGER NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0),
  source_file_id VARCHAR(36) NOT NULL REFERENCES custom_files(id),
  preview_file_id VARCHAR(36) REFERENCES custom_files(id),
  final_q_file_id VARCHAR(36) REFERENCES custom_files(id),
  pattern_file_id VARCHAR(36) REFERENCES custom_files(id),
  colors_file_id VARCHAR(36) REFERENCES custom_files(id),
  revision_count INTEGER NOT NULL DEFAULT 0,
  customer_seen_at TIMESTAMP,
  merchant_seen_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  UNIQUE (user_id, idempotency_key)
);
DO $$ BEGIN
  ALTER TABLE custom_files ADD CONSTRAINT custom_files_order_fk FOREIGN KEY (order_id) REFERENCES custom_orders(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS custom_orders_user_idx ON custom_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS custom_orders_status_idx ON custom_orders (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS custom_messages (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL REFERENCES custom_orders(id),
  sender_id VARCHAR(36) NOT NULL REFERENCES users(id),
  sender_role VARCHAR(12) NOT NULL CHECK (sender_role IN ('CUSTOMER','MERCHANT')),
  idempotency_key VARCHAR(128) NOT NULL,
  body VARCHAR(2000) NOT NULL DEFAULT '',
  file_id VARCHAR(36) REFERENCES custom_files(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, sender_id, idempotency_key),
  CHECK (length(body) > 0 OR file_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS custom_messages_order_idx ON custom_messages (order_id, created_at);

CREATE TABLE IF NOT EXISTS custom_actions (
  order_id VARCHAR(36) NOT NULL REFERENCES custom_orders(id),
  actor_id VARCHAR(36) NOT NULL REFERENCES users(id),
  idempotency_key VARCHAR(128) NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, actor_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS custom_events (
  id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL REFERENCES custom_orders(id),
  actor_id VARCHAR(36) REFERENCES users(id),
  event_type VARCHAR(32) NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS custom_events_order_idx ON custom_events (order_id, created_at);

COMMIT;
