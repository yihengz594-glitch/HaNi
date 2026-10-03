-- 服务端会话与会员套餐种子数据。上线前请在数据库迁移工具中执行，不要手动在生产库重复执行。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

INSERT INTO membership_plans
  (id, name, duration_days, amount_fen, original_amount_fen, benefits_json, sort_order, enabled, created_at, updated_at)
VALUES
  ('day', '天卡', 1, 288, NULL, '["普通制图免广告","AI生成免广告","会员专属生成额度"]', 10, TRUE, NOW(), NOW()),
  ('week', '周卡', 7, 888, 1990, '["普通制图免广告","AI生成免广告","会员专属生成额度","更多历史记录"]', 20, TRUE, NOW(), NOW()),
  ('month', '月卡', 31, 1666, 4990, '["普通制图免广告","AI生成免广告","会员专属生成额度","更多历史记录"]', 30, TRUE, NOW(), NOW()),
  ('year', '年卡', 366, 8888, 19900, '["普通制图免广告","AI生成免广告","会员专属生成额度","更多历史记录"]', 40, TRUE, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  duration_days = EXCLUDED.duration_days,
  amount_fen = EXCLUDED.amount_fen,
  original_amount_fen = EXCLUDED.original_amount_fen,
  benefits_json = EXCLUDED.benefits_json,
  sort_order = EXCLUDED.sort_order,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();
