-- 恢复按时间开通的会员套餐；金额统一使用分。
-- 依赖 001_membership.sql、002_sessions_and_seed.sql 与 003_credits_and_payment_hardening.sql。
-- 生产执行前请先备份数据库，并在迁移工具中执行一次。
BEGIN;

UPDATE membership_plans
SET name = '天卡',
    duration_days = 1,
    amount_fen = 288,
    original_amount_fen = NULL,
    product_type = 'MEMBERSHIP',
    credit_amount = 0,
    enabled = TRUE,
    updated_at = NOW()
WHERE id = 'day';

UPDATE membership_plans
SET name = '周卡',
    duration_days = 7,
    amount_fen = 888,
    original_amount_fen = 1990,
    product_type = 'MEMBERSHIP',
    credit_amount = 0,
    enabled = TRUE,
    updated_at = NOW()
WHERE id = 'week';

UPDATE membership_plans
SET name = '月卡',
    duration_days = 31,
    amount_fen = 1666,
    original_amount_fen = 4990,
    product_type = 'MEMBERSHIP',
    credit_amount = 0,
    enabled = TRUE,
    updated_at = NOW()
WHERE id = 'month';

UPDATE membership_plans
SET name = '年卡',
    duration_days = 366,
    amount_fen = 8888,
    original_amount_fen = 19900,
    product_type = 'MEMBERSHIP',
    credit_amount = 0,
    enabled = TRUE,
    updated_at = NOW()
WHERE id = 'year';

-- 旧次数商品不再出现在可购买套餐中；已有次数余额仍由现有兼容逻辑处理。
UPDATE membership_plans
SET enabled = FALSE,
    updated_at = NOW()
WHERE id IN ('credits10', 'credits30', 'credits100');

COMMIT;
