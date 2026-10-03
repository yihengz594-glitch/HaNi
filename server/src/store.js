import crypto from 'node:crypto'
import pg from 'pg'
import { config } from './config.js'

const { Pool } = pg
const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
      max: 5
    })
  : null

function requirePool() {
  if (!pool) throw new Error('DATABASE_URL 未配置')
  return pool
}

export async function query(text, values = []) {
  return requirePool().query(text, values)
}

export async function withTransaction(callback) {
  const client = await requirePool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function hashRedeemCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex')
}

export async function upsertUser({ appid, openid, unionid = null }) {
  const result = await query(
    `INSERT INTO users (id, appid, openid, unionid, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
     ON CONFLICT (appid, openid) DO UPDATE SET unionid = COALESCE(EXCLUDED.unionid, users.unionid), updated_at = NOW()
     RETURNING id, appid, openid`,
    [appid, openid, unionid]
  )
  return result.rows[0]
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400000)
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_used_at)
     VALUES ($1, $2, $3, NOW(), NOW())`,
    [hashToken(token), userId, expiresAt]
  )
  return { token, expiresAt }
}

export async function userFromSession(token) {
  const result = await query(
    `SELECT u.id, u.appid, u.openid, u.unionid
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)]
  )
  if (!result.rows[0]) return null
  await query('UPDATE sessions SET last_used_at = NOW() WHERE token_hash = $1', [hashToken(token)])
  return result.rows[0]
}

export async function getPlan(planId) {
  const result = await query(
    `SELECT id, name, duration_days, amount_fen, benefits_json, enabled, product_type, credit_amount
       FROM membership_plans WHERE id = $1 AND enabled = TRUE`,
    [planId]
  )
  return result.rows[0] || null
}

export async function getPublicProducts() {
  const result = await query(
    `SELECT id, name, duration_days, amount_fen, benefits_json, product_type, credit_amount, sort_order
       FROM membership_plans
      WHERE enabled = TRUE AND id IN ('credits10_v2', 'credits30_v2', 'credits100_v2', 'permanent_v1')
      ORDER BY sort_order ASC, id ASC`
  )
  return result.rows.map((product) => {
    let benefits = []
    try {
      benefits = JSON.parse(product.benefits_json || '[]')
    } catch {}
    return {
      id: product.id,
      name: product.name,
      description: Array.isArray(benefits) ? benefits.join(' · ') : '',
      amountFen: Number(product.amount_fen),
      priceLabel: `¥${(Number(product.amount_fen) / 100).toFixed(2)}`,
      creditAmount: Number(product.credit_amount),
      durationDays: Number(product.duration_days),
      productType: product.product_type,
      sort: Number(product.sort_order),
      badge: product.id === 'credits30_v2' ? '推荐' : product.id === 'permanent_v1' ? '永久' : '',
      featured: product.id === 'credits30_v2'
    }
  })
}

export async function getMembershipProfile(userId) {
  const [userResult, membershipResult] = await Promise.all([
    query('SELECT credits_remaining, credits_reserved, permanent_entitlement FROM users WHERE id = $1', [userId]),
    query(
    `SELECT m.plan_id, m.starts_at, m.expires_at, p.name AS plan_name
       FROM memberships m
       JOIN membership_plans p ON p.id = m.plan_id
      WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND m.expires_at > NOW()
      ORDER BY m.expires_at DESC LIMIT 1`,
    [userId]
    )
  ])
  const membership = membershipResult.rows[0]
  const user = userResult.rows[0] || {}
  const creditsBalance = Math.max(0, Number(user.credits_remaining || 0))
  const creditsReserved = Math.max(0, Number(user.credits_reserved || 0))
  const creditsRemaining = Math.max(0, creditsBalance - creditsReserved)
  const permanentEntitlement = user.permanent_entitlement === true
  if (!membership && !permanentEntitlement && creditsRemaining <= 0) {
    return {
      active: false,
      statusLabel: '未开通',
      note: '生成图纸需使用次数卡或永久权益',
      title: '高级版会员',
      description: '暂无可用生成次数',
      planName: '',
      daysRemaining: 0,
      expiresAt: '',
      creditsRemaining: 0,
      creditsReserved,
      permanentEntitlement: false,
      billingMode: 'CREDITS',
      quotaLabel: '剩余 0 次'
    }
  }
  const expiresAt = membership ? new Date(membership.expires_at) : null
  const daysRemaining = expiresAt
    ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000))
    : 0
  const planName = permanentEntitlement ? '永久卡' : membership ? membership.plan_name : '次数卡'
  const description = permanentEntitlement
    ? '永久权益 · 生成不限次数'
    : membership
    ? `${membership.plan_name} · 剩余 ${daysRemaining} 天`
    : `剩余 ${creditsRemaining} 次生成额度`
  return {
    active: true,
    statusLabel: permanentEntitlement ? '永久卡已开通' : membership ? `${membership.plan_name}会员` : '次数卡用户',
    note: permanentEntitlement ? '永久权益 · 生成不限次数' : membership ? '旧版会员有效期内生成不限次数' : '每次生成成功后扣除1次',
    title: '高级版会员',
    description,
    planName,
    daysRemaining,
    expiresAt: expiresAt ? expiresAt.toISOString() : '',
    creditsRemaining,
    creditsReserved,
    permanentEntitlement,
    billingMode: permanentEntitlement ? 'PERMANENT' : membership ? 'MEMBERSHIP' : 'CREDITS',
    quotaLabel: `剩余 ${creditsRemaining} 次`
  }
}

export async function createPaymentOrder({ userId, planId, outTradeNo, expireAt, idempotencyKey }) {
  return withTransaction(async (client) => {
    const userResult = await client.query(
      'SELECT permanent_entitlement FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    )
    if (!userResult.rows[0]) throw new Error('支付用户不存在')

    if (idempotencyKey) {
      const existingResult = await client.query(
        `SELECT po.*, p.name, p.duration_days, p.credit_amount, p.product_type, p.benefits_json, p.enabled
           FROM payment_orders po JOIN membership_plans p ON p.id = po.plan_id
          WHERE po.user_id = $1 AND po.idempotency_key = $2 LIMIT 1`,
        [userId, idempotencyKey]
      )
      if (existingResult.rows[0]) {
        const existing = existingResult.rows[0]
        return {
          reused: true,
          plan: {
            id: existing.plan_id,
            name: existing.product_name_snapshot || existing.name,
            duration_days: existing.duration_days_snapshot ?? existing.duration_days,
            amount_fen: existing.amount_fen,
            credit_amount: existing.credit_amount_snapshot ?? existing.credit_amount,
            product_type: existing.product_type_snapshot || existing.product_type,
            permanent: existing.permanent_snapshot ?? existing.product_type === 'PERMANENT',
            benefits_json: existing.benefits_json_snapshot || existing.benefits_json,
            enabled: existing.enabled
          },
          order: {
            out_trade_no: existing.out_trade_no,
            plan_id: existing.plan_id,
            amount_fen: existing.amount_fen,
            status: existing.status,
            prepay_id: existing.prepay_id,
            expire_at: existing.expire_at
          }
        }
      }
    }

    const planResult = await client.query(
      `SELECT id, name, duration_days, amount_fen, benefits_json, enabled, product_type, credit_amount
         FROM membership_plans WHERE id = $1 AND enabled = TRUE`,
      [planId]
    )
    const plan = planResult.rows[0]
    if (!plan) throw new Error('商品不存在或已下架')
    if (userResult.rows[0].permanent_entitlement) {
      throw Object.assign(new Error('永久卡已开通，无需再次购买次数或永久卡'), { code: 'PERMANENT_ALREADY_ACTIVE' })
    }
    if (plan.product_type === 'PERMANENT') {
      const pending = await client.query(
        `SELECT 1 FROM payment_orders
          WHERE user_id = $1 AND product_type_snapshot = 'PERMANENT'
            AND status IN ('PENDING', 'PREPAY_CREATED') AND expire_at > NOW() LIMIT 1`,
        [userId]
      )
      if (pending.rows[0]) throw Object.assign(new Error('已有永久卡订单待支付，请先确认该订单状态'), { code: 'PERMANENT_ORDER_PENDING' })
    }

    const result = await client.query(
      `INSERT INTO payment_orders
        (id, user_id, plan_id, out_trade_no, amount_fen, status, expire_at, idempotency_key,
         product_name_snapshot, product_type_snapshot, duration_days_snapshot, credit_amount_snapshot,
         permanent_snapshot, benefits_json_snapshot, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
       RETURNING out_trade_no, plan_id, amount_fen, status, prepay_id, expire_at`,
      [
        userId, plan.id, outTradeNo, plan.amount_fen, expireAt, idempotencyKey || null,
        plan.name, plan.product_type, plan.duration_days, plan.credit_amount,
        plan.product_type === 'PERMANENT', plan.benefits_json
      ]
    )
    return { plan, order: result.rows[0] }
  })
}

export async function setPrepayId(outTradeNo, prepayId) {
  if (!prepayId) throw new Error('微信支付未返回 prepay_id')
  const result = await query(
    `UPDATE payment_orders SET prepay_id = $2, status = 'PREPAY_CREATED', updated_at = NOW()
      WHERE out_trade_no = $1 AND status IN ('PENDING', 'PREPAY_CREATED')`,
    [outTradeNo, prepayId]
  )
  if (!result.rowCount) throw new Error('订单状态已变化，未能保存 prepay_id')
}

export async function getOrderForUser(outTradeNo, userId) {
  const result = await query(
    `SELECT out_trade_no, user_id, plan_id, amount_fen, status, transaction_id, prepay_id,
            idempotency_key, expire_at, paid_at
       FROM payment_orders WHERE out_trade_no = $1 AND user_id = $2`,
    [outTradeNo, userId]
  )
  return result.rows[0] || null
}

export async function writePaymentLog({ requestId = null, outTradeNo = null, level = 'INFO', eventType, message, detail = null }) {
  try {
    await query(
      `INSERT INTO payment_logs
        (id, request_id, out_trade_no, level, event_type, message, detail_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [crypto.randomUUID(), requestId, outTradeNo, level, eventType, message, detail ? JSON.stringify(detail) : null]
    )
  } catch (error) {
    // 审计日志不能覆盖原始支付错误；这里只保留不含敏感值的错误类型。
    console.error(`[payment-log] write failed: ${error.message}`)
  }
}

export async function applyWechatPayment({ notificationId, outTradeNo, transactionId, amountFen, tradeState, resource }) {
  return withTransaction(async (client) => {
    const normalizedTradeState = String(tradeState || 'UNKNOWN').slice(0, 20)
    const notification = await client.query(
      `INSERT INTO payment_notifications
        (id, out_trade_no, event_type, resource_json, received_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [notificationId, outTradeNo, normalizedTradeState, JSON.stringify(resource || {})]
    )
    if (!notification.rows[0]) return { duplicate: true }
    const orderResult = await client.query(
      `SELECT * FROM payment_orders WHERE out_trade_no = $1 FOR UPDATE`,
      [outTradeNo]
    )
    const order = orderResult.rows[0]
    if (!order) throw new Error('支付回调对应订单不存在')
    if (Number(order.amount_fen) !== Number(amountFen)) throw new Error('支付回调金额不匹配')
    if (normalizedTradeState !== 'SUCCESS') {
      await client.query(
        `UPDATE payment_orders SET status = $2, transaction_id = $3, updated_at = NOW(), last_error = $4 WHERE out_trade_no = $1`,
        [outTradeNo, normalizedTradeState, transactionId || null, `微信交易状态: ${normalizedTradeState}`]
      )
      await client.query('UPDATE payment_notifications SET processed_at = NOW() WHERE id = $1', [notificationId])
      await client.query(
        `INSERT INTO payment_logs
          (id, out_trade_no, level, event_type, message, detail_json, created_at)
         VALUES ($1, $2, 'INFO', 'PAYMENT_STATE', $3, $4, NOW())`,
        [crypto.randomUUID(), outTradeNo, `微信交易状态: ${normalizedTradeState}`, JSON.stringify({ transactionId: transactionId || null })]
      )
      return { paid: false, tradeState: normalizedTradeState }
    }
    if (order.status === 'PAID') {
      await client.query('UPDATE payment_notifications SET processed_at = NOW() WHERE id = $1', [notificationId])
      return { duplicate: true, paid: true }
    }
    const now = new Date()
    const planResult = await client.query(
      `SELECT duration_days, name, credit_amount, product_type
         FROM membership_plans WHERE id = $1`,
      [order.plan_id]
    )
    const configuredPlan = planResult.rows[0]
    if (!configuredPlan) throw new Error('订单套餐不存在')
    const plan = {
      duration_days: order.duration_days_snapshot ?? configuredPlan.duration_days,
      name: order.product_name_snapshot || configuredPlan.name,
      credit_amount: order.credit_amount_snapshot ?? configuredPlan.credit_amount,
      product_type: order.product_type_snapshot || configuredPlan.product_type,
      permanent: order.permanent_snapshot ?? configuredPlan.product_type === 'PERMANENT'
    }
    let creditsAdded = 0
    let creditsRemaining = null
    if (Number(plan.credit_amount) > 0) {
      const userResult = await client.query(
        `UPDATE users
            SET credits_remaining = credits_remaining + $2, updated_at = NOW()
          WHERE id = $1
        RETURNING credits_remaining, credits_reserved`,
        [order.user_id, Number(plan.credit_amount)]
      )
      if (!userResult.rows[0]) throw new Error('支付用户不存在')
      creditsAdded = Number(plan.credit_amount)
      creditsRemaining = Math.max(0, Number(userResult.rows[0].credits_remaining) - Number(userResult.rows[0].credits_reserved || 0))
      await client.query(
        `INSERT INTO credit_ledger
          (id, user_id, delta, balance_after, source_type, source_ref, feature, created_at)
         VALUES ($1, $2, $3, $4, 'PAYMENT', $5, NULL, NOW())`,
        [crypto.randomUUID(), order.user_id, creditsAdded, creditsRemaining, outTradeNo]
      )
    }
    let expiresAt = null
    if (plan.permanent || plan.product_type === 'PERMANENT') {
      await client.query(
        'UPDATE users SET permanent_entitlement = TRUE, updated_at = NOW() WHERE id = $1',
        [order.user_id]
      )
    }
    if (Number(plan.duration_days) > 0) {
      const activeMembership = await client.query(
        `SELECT * FROM memberships
          WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
          ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [order.user_id]
      )
      const current = activeMembership.rows[0]
      const startsAt = current ? new Date(current.expires_at) : now
      expiresAt = new Date(startsAt.getTime() + Number(plan.duration_days) * 86400000)
      if (current) {
        await client.query(
          `UPDATE memberships SET plan_id = $2, expires_at = $3, source_order_no = $4, updated_at = NOW() WHERE id = $1`,
          [current.id, order.plan_id, expiresAt, outTradeNo]
        )
      } else {
        await client.query(
          `INSERT INTO memberships (id, user_id, plan_id, status, starts_at, expires_at, source_order_no, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3, $4, $5, NOW(), NOW())`,
          [order.user_id, order.plan_id, startsAt, expiresAt, outTradeNo]
        )
      }
    }
    await client.query(
      `UPDATE payment_orders SET status = 'PAID', transaction_id = $2, paid_at = NOW(), updated_at = NOW() WHERE out_trade_no = $1`,
      [outTradeNo, transactionId || null]
    )
    await client.query('UPDATE payment_notifications SET processed_at = NOW() WHERE id = $1', [notificationId])
    await client.query(
      `INSERT INTO payment_logs
        (id, out_trade_no, level, event_type, message, detail_json, created_at)
       VALUES ($1, $2, 'INFO', 'PAYMENT_APPLIED', '支付已确认并发放权益', $3, NOW())`,
      [crypto.randomUUID(), outTradeNo, JSON.stringify({
        transactionId: transactionId || null,
        productType: plan.product_type || 'MEMBERSHIP',
        creditsAdded
      })]
    )
    return {
      paid: true,
      creditsAdded,
      creditsRemaining,
      expiresAt: expiresAt ? expiresAt.toISOString() : ''
    }
  })
}

export async function redeemCode({ userId, code, idempotencyKey, sourceHash = '' }) {
  if (!idempotencyKey) throw new Error('兑换请求标识无效')
  const codeHash = hashRedeemCode(code)
  const normalizedSourceHash = String(sourceHash || 'unknown').slice(0, 64)

  // Record attempts separately so a rejected/unknown code still counts toward rate limits.
  await query(
    'INSERT INTO redeem_attempts (id, user_id, source_hash, created_at) VALUES ($1, $2, $3, NOW())',
    [crypto.randomUUID(), userId, normalizedSourceHash]
  )
  const rateResult = await query(
    `SELECT COUNT(*)::integer AS user_count,
            COUNT(*) FILTER (WHERE source_hash = $2)::integer AS source_count
       FROM redeem_attempts
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
    [userId, normalizedSourceHash]
  )
  if (Number(rateResult.rows[0]?.user_count || 0) > 12 || Number(rateResult.rows[0]?.source_count || 0) > 24) {
    throw Object.assign(new Error('尝试次数较多，请15分钟后再试'), { code: 'REDEEM_RATE_LIMITED' })
  }

  return withTransaction(async (client) => {
    const userResult = await client.query(
      'SELECT credits_remaining, permanent_entitlement FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    )
    const user = userResult.rows[0]
    if (!user) throw new Error('兑换失败，请稍后重试')

    const previousRequest = await client.query(
      `SELECT code_hash, result_json FROM redeem_requests WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey]
    )
    if (previousRequest.rows[0]) {
      if (previousRequest.rows[0].code_hash !== codeHash) {
        throw Object.assign(new Error('兑换请求标识冲突，请重新提交'), { code: 'IDEMPOTENCY_CONFLICT' })
      }
      return Object.assign({}, previousRequest.rows[0].result_json, { duplicate: true })
    }

    const codeResult = await client.query(
      `SELECT c.*, p.duration_days, p.name, p.credit_amount, p.product_type
         FROM membership_redeem_codes c
         JOIN membership_plans p ON p.id = c.plan_id
        WHERE c.code_hash = $1 FOR UPDATE`,
      [codeHash]
    )
    const redeem = codeResult.rows[0]
    if (!redeem || redeem.status !== 'ACTIVE' || (redeem.expires_at && new Date(redeem.expires_at).getTime() <= Date.now())) {
      throw Object.assign(new Error('兑换码无效、已使用、已停用或已过期'), { code: 'REDEEM_INVALID' })
    }
    if (user.permanent_entitlement) {
      const message = redeem.product_type === 'PERMANENT'
        ? '永久权益已开通，该兑换码未使用'
        : '你已拥有永久权益，次数兑换码未使用'
      throw Object.assign(new Error(message), { code: 'PERMANENT_ALREADY_ACTIVE' })
    }

    const pendingPermanentOrder = await client.query(
      `SELECT 1 FROM payment_orders
        WHERE user_id = $1 AND product_type_snapshot = 'PERMANENT'
          AND status IN ('PENDING', 'PREPAY_CREATED') AND expire_at > NOW() LIMIT 1`,
      [userId]
    )
    if (redeem.product_type === 'PERMANENT' && pendingPermanentOrder.rows[0]) {
      throw Object.assign(new Error('已有永久卡订单待确认，请先查询订单状态；本兑换码尚未使用'), { code: 'PERMANENT_ORDER_PENDING' })
    }

    let creditsAdded = 0
    let creditsRemaining = Math.max(0, Number(user.credits_remaining || 0))
    let permanentEntitlement = false
    if (redeem.product_type === 'PERMANENT') {
      await client.query('UPDATE users SET permanent_entitlement = TRUE, updated_at = NOW() WHERE id = $1', [userId])
      permanentEntitlement = true
    } else if (Number(redeem.credit_amount) > 0) {
      const updated = await client.query(
        `UPDATE users SET credits_remaining = credits_remaining + $2, updated_at = NOW()
          WHERE id = $1 RETURNING credits_remaining, credits_reserved`,
        [userId, Number(redeem.credit_amount)]
      )
      creditsAdded = Number(redeem.credit_amount)
      creditsRemaining = Math.max(0, Number(updated.rows[0].credits_remaining) - Number(updated.rows[0].credits_reserved || 0))
      await client.query(
        `INSERT INTO credit_ledger
          (id, user_id, delta, balance_after, source_type, source_ref, feature, created_at)
         VALUES ($1, $2, $3, $4, 'REDEEM', $5, NULL, NOW())`,
        [crypto.randomUUID(), userId, creditsAdded, creditsRemaining, redeem.id]
      )
    }

    let expiresAt = null
    if (Number(redeem.duration_days) > 0) {
      const activeMembership = await client.query(
        `SELECT * FROM memberships WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
          ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [userId]
      )
      const current = activeMembership.rows[0]
      const startsAt = current ? new Date(current.expires_at) : new Date()
      expiresAt = new Date(startsAt.getTime() + Number(redeem.duration_days) * 86400000)
      if (current) {
        await client.query(
          'UPDATE memberships SET plan_id = $2, expires_at = $3, updated_at = NOW() WHERE id = $1',
          [current.id, redeem.plan_id, expiresAt]
        )
      } else {
        await client.query(
          `INSERT INTO memberships (id, user_id, plan_id, status, starts_at, expires_at, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3, $4, NOW(), NOW())`,
          [userId, redeem.plan_id, startsAt, expiresAt]
        )
      }
    }
    await client.query(
      `UPDATE membership_redeem_codes SET status = 'REDEEMED', redeemed_by = $2, redeemed_at = NOW()
        WHERE id = $1 AND status = 'ACTIVE'`,
      [redeem.id, userId]
    )
    const result = {
      creditsAdded,
      creditsRemaining,
      permanentEntitlement,
      expiresAt: expiresAt ? expiresAt.toISOString() : '',
      productName: redeem.name
    }
    await client.query(
      `INSERT INTO redeem_requests (user_id, idempotency_key, code_hash, result_json, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, idempotencyKey, codeHash, JSON.stringify(result)]
    )
    return result
  })
}

export async function consumeCredit({ userId, requestId, feature = 'pattern' }) {
  if (!requestId) throw new Error('缺少扣次请求号')
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT balance_after FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'CONSUME' AND source_ref = $2
        LIMIT 1`,
      [userId, requestId]
    )
    if (existing.rows[0]) {
      return {
        allowed: true,
        duplicate: true,
        mode: 'CREDITS',
        creditsRemaining: Number(existing.rows[0].balance_after)
      }
    }

    const membership = await client.query(
      `SELECT id FROM memberships
        WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
        ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    )
    if (membership.rows[0]) {
      const balance = await client.query('SELECT credits_remaining FROM users WHERE id = $1', [userId])
      return {
        allowed: true,
        duplicate: false,
        mode: 'MEMBERSHIP',
        creditsRemaining: Number(balance.rows[0]?.credits_remaining || 0)
      }
    }

    const update = await client.query(
      `UPDATE users
          SET credits_remaining = credits_remaining - 1, updated_at = NOW()
        WHERE id = $1 AND credits_remaining > 0
      RETURNING credits_remaining`,
      [userId]
    )
    if (!update.rows[0]) {
      const balance = await client.query('SELECT credits_remaining FROM users WHERE id = $1', [userId])
      return {
        allowed: false,
        mode: 'CREDITS',
        creditsRemaining: Number(balance.rows[0]?.credits_remaining || 0),
        reason: 'INSUFFICIENT_CREDITS'
      }
    }
    const creditsRemaining = Number(update.rows[0].credits_remaining)
    await client.query(
      `INSERT INTO credit_ledger
        (id, user_id, delta, balance_after, source_type, source_ref, feature, created_at)
       VALUES ($1, $2, -1, $3, 'CONSUME', $4, $5, NOW())`,
      [crypto.randomUUID(), userId, creditsRemaining, requestId, String(feature).slice(0, 64)]
    )
    return { allowed: true, duplicate: false, mode: 'CREDITS', creditsRemaining }
  })
}

export async function getCreditBalance(userId) {
  const result = await query('SELECT credits_remaining, credits_reserved FROM users WHERE id = $1', [userId])
  return Math.max(0, Number(result.rows[0]?.credits_remaining || 0) - Number(result.rows[0]?.credits_reserved || 0))
}

export async function reserveGenerationTask({ userId, idempotencyKey, requestHash, settings }) {
  if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('生成任务标识无效')
  return withTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT credits_remaining, credits_reserved, permanent_entitlement FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    )
    const user = userResult.rows[0]
    if (!user) throw new Error('生成账户不存在')

    const existingResult = await client.query(
      `SELECT id, request_hash, status, billing_mode, credit_cost, result_json, error_code
         FROM generation_tasks WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [userId, idempotencyKey]
    )
    const existing = existingResult.rows[0]
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw Object.assign(new Error('同一请求标识不能用于不同图片或参数'), { code: 'IDEMPOTENCY_CONFLICT' })
      }
      return {
        allowed: true,
        taskId: existing.id,
        status: existing.status,
        billingMode: existing.billing_mode,
        creditCost: Number(existing.credit_cost),
        result: existing.result_json,
        errorCode: existing.error_code,
        duplicate: true,
        creditsRemaining: Math.max(0, Number(user.credits_remaining) - Number(user.credits_reserved))
      }
    }

    const membership = await client.query(
      `SELECT id FROM memberships WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
        ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    )
    const billingMode = user.permanent_entitlement ? 'PERMANENT' : membership.rows[0] ? 'MEMBERSHIP' : 'CREDITS'
    const creditCost = billingMode === 'CREDITS' ? 1 : 0
    const available = Math.max(0, Number(user.credits_remaining) - Number(user.credits_reserved))
    if (creditCost > available) {
      return { allowed: false, reason: 'INSUFFICIENT_CREDITS', creditsRemaining: available, billingMode }
    }

    const taskId = crypto.randomUUID()
    if (creditCost > 0) {
      await client.query(
        'UPDATE users SET credits_reserved = credits_reserved + $2, updated_at = NOW() WHERE id = $1',
        [userId, creditCost]
      )
    }
    await client.query(
      `INSERT INTO generation_tasks
        (id, user_id, idempotency_key, request_hash, feature, status, billing_mode, credit_cost,
         reserved_credits, settings_json, lease_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'DIRECT_PATTERN', 'PROCESSING', $5, $6, $6, $7, NOW() + INTERVAL '3 minutes', NOW(), NOW())`,
      [taskId, userId, idempotencyKey, requestHash, billingMode, creditCost, JSON.stringify(settings)]
    )
    await client.query(
      `INSERT INTO generation_task_events
        (id, task_id, user_id, event_type, credit_delta, balance_after, detail_json, created_at)
       VALUES ($1, $2, $3, 'RESERVED', $4, $5, $6, NOW())`,
      [crypto.randomUUID(), taskId, userId, -creditCost, available, JSON.stringify({ billingMode })]
    )
    return {
      allowed: true,
      taskId,
      status: 'PROCESSING',
      billingMode,
      creditCost,
      duplicate: false,
      creditsRemaining: available
    }
  })
}

export async function completeGenerationTask({ taskId, userId, result }) {
  return withTransaction(async (client) => {
    const taskResult = await client.query(
      'SELECT * FROM generation_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [taskId, userId]
    )
    const task = taskResult.rows[0]
    if (!task) throw new Error('生成任务不存在')
    if (task.status !== 'PROCESSING') {
      return { status: task.status, result: task.result_json, duplicate: true }
    }
    const userResult = await client.query(
      'SELECT credits_remaining, credits_reserved FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    )
    const user = userResult.rows[0]
    if (!user) throw new Error('生成账户不存在')
    let creditsRemaining = Math.max(0, Number(user.credits_remaining) - Number(user.credits_reserved))
    if (Number(task.reserved_credits) > 0) {
      const settled = await client.query(
        `UPDATE users SET credits_remaining = credits_remaining - $2,
                          credits_reserved = credits_reserved - $2, updated_at = NOW()
          WHERE id = $1 AND credits_remaining >= $2 AND credits_reserved >= $2
          RETURNING credits_remaining, credits_reserved`,
        [userId, Number(task.reserved_credits)]
      )
      if (!settled.rows[0]) throw new Error('生成额度结算状态不一致')
      creditsRemaining = Math.max(0, Number(settled.rows[0].credits_remaining) - Number(settled.rows[0].credits_reserved))
      await client.query(
        `INSERT INTO credit_ledger
          (id, user_id, delta, balance_after, source_type, source_ref, feature, created_at)
         VALUES ($1, $2, $3, $4, 'CONSUME', $5, 'pattern', NOW())`,
        [crypto.randomUUID(), userId, -Number(task.reserved_credits), creditsRemaining, taskId]
      )
    }
    await client.query(
      `UPDATE generation_tasks SET status = 'SUCCEEDED', result_json = $2, reserved_credits = 0,
              lease_until = NULL, error_code = NULL, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [taskId, JSON.stringify(result)]
    )
    await client.query(
      `INSERT INTO generation_task_events
        (id, task_id, user_id, event_type, credit_delta, balance_after, detail_json, created_at)
       VALUES ($1, $2, $3, 'SUCCEEDED', $4, $5, $6, NOW())`,
      [crypto.randomUUID(), taskId, userId, -Number(task.credit_cost), creditsRemaining, JSON.stringify({ billingMode: task.billing_mode })]
    )
    return { status: 'SUCCEEDED', result, creditsRemaining, duplicate: false }
  })
}

export async function failGenerationTask({ taskId, userId, errorCode = 'PATTERN_PROCESSING_FAILED' }) {
  return withTransaction(async (client) => {
    const taskResult = await client.query(
      'SELECT * FROM generation_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [taskId, userId]
    )
    const task = taskResult.rows[0]
    if (!task) throw new Error('生成任务不存在')
    if (task.status !== 'PROCESSING') {
      return { status: task.status, duplicate: true }
    }
    const userResult = await client.query(
      'SELECT credits_remaining, credits_reserved FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    )
    const user = userResult.rows[0]
    if (!user) throw new Error('生成账户不存在')
    let reserved = Number(user.credits_reserved || 0)
    if (Number(task.reserved_credits) > 0) {
      const released = await client.query(
        `UPDATE users SET credits_reserved = credits_reserved - $2, updated_at = NOW()
          WHERE id = $1 AND credits_reserved >= $2 RETURNING credits_remaining, credits_reserved`,
        [userId, Number(task.reserved_credits)]
      )
      if (!released.rows[0]) throw new Error('生成额度释放状态不一致')
      reserved = Number(released.rows[0].credits_reserved)
    }
    const available = Math.max(0, Number(user.credits_remaining) - reserved)
    await client.query(
      `UPDATE generation_tasks SET status = 'FAILED', error_code = $2, reserved_credits = 0,
              lease_until = NULL, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [taskId, String(errorCode).slice(0, 48)]
    )
    await client.query(
      `INSERT INTO generation_task_events
        (id, task_id, user_id, event_type, credit_delta, balance_after, detail_json, created_at)
       VALUES ($1, $2, $3, 'RELEASED', $4, $5, $6, NOW())`,
      [crypto.randomUUID(), taskId, userId, Number(task.reserved_credits), available, JSON.stringify({ errorCode })]
    )
    return { status: 'FAILED', errorCode, creditsRemaining: available, duplicate: false }
  })
}

export async function getGenerationTask({ taskId, userId }) {
  const result = await query(
    `SELECT id, status, billing_mode, credit_cost, result_json, error_code, created_at, completed_at
       FROM generation_tasks WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  )
  return result.rows[0] || null
}

export async function getGenerationTaskByKey({ idempotencyKey, userId }) {
  const result = await query(
    `SELECT id, status, billing_mode, credit_cost, result_json, error_code, created_at, completed_at
       FROM generation_tasks WHERE idempotency_key = $1 AND user_id = $2`,
    [idempotencyKey, userId]
  )
  return result.rows[0] || null
}

export async function recoverAbandonedGenerationTasks() {
  const stale = await query(
    `SELECT id, user_id FROM generation_tasks WHERE status = 'PROCESSING' AND lease_until < NOW() LIMIT 100`
  )
  for (const task of stale.rows) {
    await failGenerationTask({ taskId: task.id, userId: task.user_id, errorCode: 'WORKER_INTERRUPTED' })
  }
  return stale.rowCount
}

export async function getAccountHistory(userId) {
  const result = await query(
    `SELECT event_type, title, detail, amount_fen, credit_delta, created_at FROM (
       SELECT 'PAYMENT'::text AS event_type,
              COALESCE(po.product_name_snapshot, p.name) AS title,
              '微信支付 · ' || po.status AS detail,
              po.amount_fen::integer AS amount_fen,
              COALESCE(po.credit_amount_snapshot, p.credit_amount, 0)::integer AS credit_delta,
              COALESCE(po.paid_at, po.created_at) AS created_at
         FROM payment_orders po JOIN membership_plans p ON p.id = po.plan_id
        WHERE po.user_id = $1
       UNION ALL
       SELECT 'REDEEM', p.name, '兑换成功', 0, COALESCE(p.credit_amount, 0)::integer, c.redeemed_at
         FROM membership_redeem_codes c JOIN membership_plans p ON p.id = c.plan_id
        WHERE c.redeemed_by = $1 AND c.status = 'REDEEMED'
       UNION ALL
       SELECT CASE WHEN cl.source_type = 'CONSUME' THEN 'USAGE' ELSE cl.source_type END,
              CASE WHEN cl.delta < 0 THEN '拼豆图纸生成' ELSE '次数变动' END,
              cl.feature, 0, cl.delta, cl.created_at
         FROM credit_ledger cl WHERE cl.user_id = $1 AND cl.source_type = 'CONSUME'
       UNION ALL
       SELECT 'USAGE', '拼豆图纸生成', g.billing_mode, 0, 0, g.completed_at
         FROM generation_tasks g WHERE g.user_id = $1 AND g.status = 'SUCCEEDED' AND g.credit_cost = 0
     ) history ORDER BY created_at DESC NULLS LAST LIMIT 100`,
    [userId]
  )
  return result.rows.map((row) => ({
    type: row.event_type,
    title: row.title,
    detail: row.detail || '',
    amountFen: Number(row.amount_fen || 0),
    creditDelta: Number(row.credit_delta || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : ''
  }))
}
