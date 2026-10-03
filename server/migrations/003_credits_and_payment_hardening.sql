-- 次数制权益、支付幂等和支付审计日志。
-- 依赖 001_membership.sql 与 002_sessions_and_seed.sql，生产执行前先备份数据库。
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credits_remaining INTEGER NOT NULL DEFAULT 0;

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) NOT NULL DEFAULT 'MEMBERSHIP';

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS credit_amount INTEGER NOT NULL DEFAULT 0;

ALTER TABLE membership_plans
  DROP CONSTRAINT IF EXISTS membership_plans_duration_days_check;

ALTER TABLE membership_plans
  ADD CONSTRAINT membership_plans_duration_days_check CHECK (duration_days >= 0);

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_user_idempotency_idx
  ON payment_orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_ledger (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  source_type VARCHAR(24) NOT NULL,
  source_ref VARCHAR(128) NOT NULL,
  feature VARCHAR(64),
  created_at TIMESTAMP NOT NULL,
  UNIQUE (user_id, source_type, source_ref)
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx
  ON credit_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_logs (
  id VARCHAR(64) PRIMARY KEY,
  request_id VARCHAR(128),
  out_trade_no VARCHAR(32),
  level VARCHAR(16) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_logs_order_created_idx
  ON payment_logs (out_trade_no, created_at DESC);

INSERT INTO membership_plans
  (id, name, duration_days, amount_fen, original_amount_fen, benefits_json, sort_order,
   enabled, created_at, updated_at, product_type, credit_amount)
VALUES
  ('credits10', '10次', 0, 100, NULL,
   '["普通制图和 AI 生成按次扣除","服务端到账","支持重复购买叠加"]',
   10, TRUE, NOW(), NOW(), 'CREDITS', 10),
  ('credits30', '30次', 0, 288, 399,
   '["普通制图和 AI 生成按次扣除","服务端到账","支持重复购买叠加"]',
   20, TRUE, NOW(), NOW(), 'CREDITS', 30),
  ('credits100', '100次', 0, 688, 999,
   '["普通制图和 AI 生成按次扣除","服务端到账","支持重复购买叠加"]',
   30, TRUE, NOW(), NOW(), 'CREDITS', 100)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  duration_days = EXCLUDED.duration_days,
  amount_fen = EXCLUDED.amount_fen,
  original_amount_fen = EXCLUDED.original_amount_fen,
  benefits_json = EXCLUDED.benefits_json,
  sort_order = EXCLUDED.sort_order,
  enabled = EXCLUDED.enabled,
  updated_at = NOW(),
  product_type = EXCLUDED.product_type,
  credit_amount = EXCLUDED.credit_amount;

COMMIT;
