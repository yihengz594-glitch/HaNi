-- 会员与微信支付最小数据模型。金额统一使用分，服务端永远按 plan_id 读取价格。
CREATE TABLE membership_plans (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  original_amount_fen INTEGER CHECK (original_amount_fen IS NULL OR original_amount_fen >= amount_fen),
  benefits_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  appid VARCHAR(32) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  unionid VARCHAR(64),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE (appid, openid)
);

CREATE TABLE memberships (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL,
  starts_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  source_order_no VARCHAR(32),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE INDEX memberships_user_status_idx ON memberships (user_id, status, expires_at);

CREATE TABLE payment_orders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(32) NOT NULL,
  out_trade_no VARCHAR(32) NOT NULL UNIQUE,
  transaction_id VARCHAR(64),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status VARCHAR(20) NOT NULL,
  prepay_id VARCHAR(128),
  paid_at TIMESTAMP,
  expire_at TIMESTAMP NOT NULL,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE INDEX payment_orders_user_idx ON payment_orders (user_id, created_at);

CREATE TABLE payment_notifications (
  id VARCHAR(64) PRIMARY KEY,
  out_trade_no VARCHAR(32) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  resource_json TEXT NOT NULL,
  received_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP,
  UNIQUE (out_trade_no, id)
);

CREATE TABLE membership_redeem_codes (
  id VARCHAR(36) PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL UNIQUE,
  plan_id VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL,
  redeemed_by VARCHAR(36),
  redeemed_at TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL
);
