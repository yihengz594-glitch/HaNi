import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'
import { query, withTransaction } from './store.js'

const scrypt = promisify(crypto.scrypt)
const SESSION_MS = Math.max(1, Number(config.admin.sessionHours) || 8) * 60 * 60 * 1000
const PRODUCT_IDS = new Set(['credits10_v2', 'credits30_v2', 'credits100_v2', 'permanent_v1'])

export function hashAdminToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

export async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const derived = await scrypt(String(password), salt, 64)
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`
}

export async function verifyPassword(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || '').split('$')
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false
  const derived = Buffer.from(await scrypt(String(password), salt, 64))
  const expected = Buffer.from(expectedHex, 'hex')
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
}

export async function bootstrapAdminIfConfigured() {
  if (!config.admin.bootstrapUsername || !config.admin.bootstrapPassword) return false
  if (config.admin.bootstrapPassword.length < 14) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD 至少需要14个字符')
  }
  const existing = await query('SELECT 1 FROM admin_users LIMIT 1')
  if (existing.rows.length) return false
  const passwordHash = await makePasswordHash(config.admin.bootstrapPassword)
  await query(
    `INSERT INTO admin_users (id, username, password_hash, disabled, created_at)
     VALUES ($1, $2, $3, FALSE, NOW()) ON CONFLICT (username) DO NOTHING`,
    [crypto.randomUUID(), config.admin.bootstrapUsername.trim().slice(0, 80), passwordHash]
  )
  return true
}

export async function getAdminByUsername(username) {
  const result = await query(
    'SELECT id, username, password_hash, disabled FROM admin_users WHERE username = $1',
    [username]
  )
  return result.rows[0] || null
}

export async function countAdminLoginAttempts(identityHash) {
  const result = await query(
    `SELECT COUNT(*)::integer AS count FROM admin_login_attempts
      WHERE identity_hash = $1 AND succeeded = FALSE AND created_at > NOW() - INTERVAL '15 minutes'`,
    [identityHash]
  )
  return Number(result.rows[0]?.count || 0)
}

export async function recordAdminLoginAttempt(identityHash, succeeded) {
  await query(
    `INSERT INTO admin_login_attempts (id, identity_hash, succeeded, created_at) VALUES ($1, $2, $3, NOW())`,
    [crypto.randomUUID(), identityHash, Boolean(succeeded)]
  )
}

export async function createAdminSession(adminId) {
  const token = crypto.randomBytes(32).toString('base64url')
  const csrfToken = crypto.randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_MS)
  await query(
    `INSERT INTO admin_sessions (token_hash, admin_id, csrf_hash, expires_at, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [hashAdminToken(token), adminId, hashAdminToken(csrfToken), expiresAt]
  )
  return { token, csrfToken, expiresAt }
}

export async function adminFromSession(token) {
  const tokenHash = hashAdminToken(token)
  const result = await query(
    `SELECT s.token_hash, s.csrf_hash, s.expires_at, a.id, a.username
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND a.disabled = FALSE`,
    [tokenHash]
  )
  if (!result.rows[0]) return null
  await query('UPDATE admin_sessions SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash])
  return result.rows[0]
}

export async function rotateAdminCsrf(token) {
  const csrfToken = crypto.randomBytes(24).toString('base64url')
  const result = await query(
    `UPDATE admin_sessions SET csrf_hash = $2, last_used_at = NOW()
      WHERE token_hash = $1 AND expires_at > NOW() RETURNING token_hash`,
    [hashAdminToken(token), hashAdminToken(csrfToken)]
  )
  return result.rows[0] ? csrfToken : ''
}

export async function deleteAdminSession(token) {
  await query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashAdminToken(token)])
}

export async function addAdminAudit({ adminId, eventType, targetId = null, detail = {} }) {
  await query(
    `INSERT INTO admin_audit_events (id, admin_id, event_type, target_id, detail_json, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [crypto.randomUUID(), adminId, eventType, targetId, JSON.stringify(detail)]
  )
}

export async function searchAdminUsers(search = '') {
  const normalized = String(search || '').trim().slice(0, 80)
  const result = await query(
    `SELECT u.id, RIGHT(u.openid, 4) AS openid_suffix, u.created_at, u.credits_remaining,
            u.credits_reserved, u.permanent_entitlement,
            (SELECT MAX(m.expires_at) FROM memberships m
              WHERE m.user_id = u.id AND m.status = 'ACTIVE' AND m.expires_at > NOW()) AS membership_expires_at
       FROM users u
      WHERE ($1 = '' OR u.id ILIKE '%' || $1 || '%' OR u.openid ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC LIMIT 100`,
    [normalized]
  )
  return result.rows.map((row) => ({
    id: row.id,
    openidSuffix: row.openid_suffix,
    createdAt: row.created_at,
    creditsRemaining: Math.max(0, Number(row.credits_remaining) - Number(row.credits_reserved)),
    creditsReserved: Number(row.credits_reserved),
    permanentEntitlement: row.permanent_entitlement === true,
    membershipExpiresAt: row.membership_expires_at || null
  }))
}

export async function getAdminUserDetail(userId) {
  const userResult = await query(
    `SELECT id, RIGHT(openid, 4) AS openid_suffix, created_at, credits_remaining,
            credits_reserved, permanent_entitlement FROM users WHERE id = $1`,
    [userId]
  )
  if (!userResult.rows[0]) return null
  const [ledger, orders, codes, tasks] = await Promise.all([
    query(`SELECT source_type, source_ref, delta, balance_after, feature, created_at
             FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]),
    query(`SELECT po.out_trade_no, po.status, po.amount_fen, po.product_name_snapshot,
                  po.product_type_snapshot, po.paid_at, po.created_at
             FROM payment_orders po WHERE po.user_id = $1 ORDER BY po.created_at DESC LIMIT 50`, [userId]),
    query(`SELECT c.id, c.status, c.plan_id, c.created_at, c.redeemed_at, c.expires_at, p.name
             FROM membership_redeem_codes c JOIN membership_plans p ON p.id = c.plan_id
            WHERE c.redeemed_by = $1 ORDER BY c.redeemed_at DESC LIMIT 50`, [userId]),
    query(`SELECT id, status, billing_mode, credit_cost, error_code, created_at, completed_at
             FROM generation_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId])
  ])
  const user = userResult.rows[0]
  return {
    user: {
      id: user.id,
      openidSuffix: user.openid_suffix,
      createdAt: user.created_at,
      creditsRemaining: Math.max(0, Number(user.credits_remaining) - Number(user.credits_reserved)),
      creditsReserved: Number(user.credits_reserved),
      permanentEntitlement: user.permanent_entitlement === true
    },
    ledger: ledger.rows,
    orders: orders.rows,
    redemptions: codes.rows,
    tasks: tasks.rows
  }
}

export async function listAdminBatches() {
  const result = await query(
    `SELECT b.id, b.plan_id, p.name AS product_name, b.created_by, b.note, b.expires_at,
            b.code_count, b.created_at,
            COUNT(c.id)::integer AS existing_count,
            COUNT(c.id) FILTER (WHERE c.status = 'ACTIVE' AND (c.expires_at IS NULL OR c.expires_at > NOW()))::integer AS unused_count,
            COUNT(c.id) FILTER (WHERE c.status = 'REDEEMED')::integer AS redeemed_count,
            COUNT(c.id) FILTER (WHERE c.status = 'DISABLED')::integer AS disabled_count,
            COUNT(c.id) FILTER (WHERE c.status = 'ACTIVE' AND c.expires_at <= NOW())::integer AS expired_count
       FROM membership_redeem_batches b JOIN membership_plans p ON p.id = b.plan_id
       LEFT JOIN membership_redeem_codes c ON c.batch_id = b.id
      GROUP BY b.id, p.name ORDER BY b.created_at DESC LIMIT 100`,
    []
  )
  return result.rows
}

export async function listAdminCodes({ batchId, status = '' }) {
  const allowed = new Set(['UNREDEEMED', 'REDEEMED', 'DISABLED', 'EXPIRED'])
  const filter = allowed.has(status) ? status : ''
  const result = await query(
    `SELECT c.id, c.plan_id, p.name AS product_name, c.status, c.redeemed_by, c.redeemed_at,
            c.expires_at, c.created_at, b.note AS batch_note,
            CASE WHEN c.status = 'REDEEMED' THEN 'REDEEMED'
                 WHEN c.status = 'DISABLED' THEN 'DISABLED'
                 WHEN c.status = 'ACTIVE' AND c.expires_at IS NOT NULL AND c.expires_at <= NOW() THEN 'EXPIRED'
                 ELSE 'UNREDEEMED' END AS effective_status
       FROM membership_redeem_codes c JOIN membership_plans p ON p.id = c.plan_id
       LEFT JOIN membership_redeem_batches b ON b.id = c.batch_id
      WHERE ($1 = '' OR c.batch_id = $1)
        AND ($2 = '' OR ($2 = 'UNREDEEMED' AND c.status = 'ACTIVE' AND (c.expires_at IS NULL OR c.expires_at > NOW()))
          OR ($2 = 'EXPIRED' AND c.status = 'ACTIVE' AND c.expires_at <= NOW())
          OR ($2 = 'REDEEMED' AND c.status = 'REDEEMED') OR ($2 = 'DISABLED' AND c.status = 'DISABLED'))
      ORDER BY c.created_at DESC LIMIT 500`,
    [batchId ? String(batchId).slice(0, 36) : '', filter]
  )
  return result.rows
}

export async function createCodeBatch({ adminId, planId, count, note, expiresAt }) {
  const normalizedPlanId = String(planId || '')
  const amount = Number(count)
  if (!PRODUCT_IDS.has(normalizedPlanId)) throw new Error('请选择有效商品')
  if (!Number.isInteger(amount) || amount < 1 || amount > 500) throw new Error('每批可生成1至500个兑换码')
  return withTransaction(async (client) => {
    const planResult = await client.query(
      `SELECT id, name FROM membership_plans WHERE id = $1 AND enabled = TRUE AND product_type IN ('CREDITS', 'PERMANENT')`,
      [normalizedPlanId]
    )
    const plan = planResult.rows[0]
    if (!plan) throw new Error('商品不存在或已下架')
    const batchId = crypto.randomUUID()
    await client.query(
      `INSERT INTO membership_redeem_batches
        (id, plan_id, created_by, note, expires_at, code_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [batchId, planId, adminId, String(note || '').trim().slice(0, 240), expiresAt || null, amount]
    )
    const codes = Array.from({ length: amount }, () => crypto.randomBytes(20).toString('hex').toUpperCase())
    const insertParams = []
    const values = codes.map((code) => {
      const base = insertParams.length
      insertParams.push(crypto.randomUUID(), crypto.createHash('sha256').update(code).digest('hex'), planId, expiresAt || null, batchId)
      return `($${base + 1}, $${base + 2}, $${base + 3}, 'ACTIVE', $${base + 4}, NOW(), $${base + 5})`
    })
    await client.query(
      `INSERT INTO membership_redeem_codes (id, code_hash, plan_id, status, expires_at, created_at, batch_id)
       VALUES ${values.join(', ')}`,
      insertParams
    )
    await client.query(
      `INSERT INTO admin_audit_events (id, admin_id, event_type, target_id, detail_json, created_at)
       VALUES ($1, $2, 'CODES_CREATED', $3, $4, NOW())`,
      [crypto.randomUUID(), adminId, batchId, JSON.stringify({ planId, productName: plan.name, count: amount, note: String(note || '').trim().slice(0, 240) })]
    )
    return { batchId, planName: plan.name, count: amount, codes }
  })
}

export async function disableAdminCode({ adminId, codeId }) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE membership_redeem_codes SET status = 'DISABLED'
        WHERE id = $1 AND status = 'ACTIVE' AND redeemed_by IS NULL
        RETURNING id, batch_id`,
      [codeId]
    )
    if (!result.rows[0]) return false
    await client.query(
      `INSERT INTO admin_audit_events (id, admin_id, event_type, target_id, detail_json, created_at)
       VALUES ($1, $2, 'CODE_DISABLED', $3, '{}'::jsonb, NOW())`,
      [crypto.randomUUID(), adminId, codeId]
    )
    return true
  })
}

export async function disableAdminBatch({ adminId, batchId }) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE membership_redeem_codes SET status = 'DISABLED'
        WHERE batch_id = $1 AND status = 'ACTIVE' AND redeemed_by IS NULL`,
      [batchId]
    )
    await client.query(
      `INSERT INTO admin_audit_events (id, admin_id, event_type, target_id, detail_json, created_at)
       VALUES ($1, $2, 'BATCH_CODES_DISABLED', $3, $4, NOW())`,
      [crypto.randomUUID(), adminId, batchId, JSON.stringify({ count: result.rowCount })]
    )
    return result.rowCount
  })
}

export async function recordCodeExport({ adminId, batchId, count }) {
  await addAdminAudit({
    adminId,
    eventType: 'CODES_EXPORTED_ONCE',
    targetId: batchId,
    detail: { count: Math.min(500, Math.max(0, Number(count) || 0)) }
  })
}

export async function listAdminAudit() {
  const result = await query(
    `SELECT e.id, e.event_type, e.target_id, e.detail_json, e.created_at, a.username
       FROM admin_audit_events e LEFT JOIN admin_users a ON a.id = e.admin_id
      ORDER BY e.created_at DESC LIMIT 200`
  )
  return result.rows
}

export async function listAdminTransactions() {
  const result = await query(
    `SELECT id, event_type, title, detail, out_trade_no, created_at
       FROM (
         SELECT po.id, po.status::text AS event_type,
                COALESCE(po.product_name_snapshot, p.name, po.plan_id)::text AS title,
                CONCAT('¥', TO_CHAR(po.amount_fen / 100.0, 'FM999999990.00'), ' · ', po.status)::text AS detail,
                po.out_trade_no::text AS out_trade_no, COALESCE(po.paid_at, po.created_at) AS created_at
           FROM payment_orders po LEFT JOIN membership_plans p ON p.id = po.plan_id
         UNION ALL
         SELECT c.id, 'REDEEMED'::text AS event_type, p.name::text AS title,
                CONCAT('兑换用户尾号 ', RIGHT(COALESCE(u.openid, ''), 4))::text AS detail,
                c.id::text AS out_trade_no, c.redeemed_at AS created_at
           FROM membership_redeem_codes c JOIN membership_plans p ON p.id = c.plan_id
           LEFT JOIN users u ON u.id = c.redeemed_by WHERE c.status = 'REDEEMED'
         UNION ALL
         SELECT cl.id, cl.source_type::text AS event_type, COALESCE(cl.feature, '次数变动')::text AS title,
                CONCAT('次数 ', cl.delta, ' · 可用余额 ', cl.balance_after)::text AS detail,
                cl.source_ref::text AS out_trade_no, cl.created_at
           FROM credit_ledger cl WHERE cl.source_type <> 'CONSUME'
         UNION ALL
         SELECT e.id, e.event_type::text AS event_type, t.feature::text AS title,
                CONCAT('额度变动 ', e.credit_delta, ' · 可用余额 ', e.balance_after)::text AS detail,
                t.id::text AS out_trade_no, e.created_at
           FROM generation_task_events e JOIN generation_tasks t ON t.id = e.task_id
         UNION ALL
         SELECT l.id, l.event_type::text AS event_type, COALESCE(l.out_trade_no, l.request_id, '支付服务')::text AS title,
                l.message::text AS detail, l.out_trade_no::text AS out_trade_no, l.created_at
           FROM payment_logs l
       ) records
      ORDER BY created_at DESC LIMIT 200`
  )
  return result.rows
}

export async function markAdminLogin(adminId) {
  await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [adminId])
}
