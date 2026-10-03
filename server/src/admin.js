import crypto from 'node:crypto'
import express from 'express'
import { config, isProduction } from './config.js'
import { adminRefundCustomOrder, getCustomAccess, updateCustomAccess } from './custom-store.js'
import {
  addAdminAudit,
  adminFromSession,
  bootstrapAdminIfConfigured,
  countAdminLoginAttempts,
  createAdminSession,
  createCodeBatch,
  deleteAdminSession,
  disableAdminBatch,
  disableAdminCode,
  getAdminByUsername,
  getAdminUserDetail,
  listAdminAudit,
  listAdminBatches,
  listAdminCodes,
  listAdminTransactions,
  markAdminLogin,
  recordAdminLoginAttempt,
  recordCodeExport,
  rotateAdminCsrf,
  searchAdminUsers,
  verifyPassword,
  hashAdminToken
} from './admin-store.js'

const SESSION_COOKIE = 'pinbead_admin_session'
const fail = (res, status, message) => res.status(status).json({ error: message, message })
const ok = (res, data) => res.status(200).json(data)

void bootstrapAdminIfConfigured().catch((error) => {
  console.error(`[admin] bootstrap check failed: ${error.code || error.name || 'database'}`)
})

function cookieToken(req) {
  const cookies = String(req.headers.cookie || '').split(';')
  const entry = cookies.map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))
  return entry ? decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)) : ''
}

function setSessionCookie(res, token, maxAge) {
  const pieces = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`
  ]
  if (isProduction) pieces.push('Secure')
  res.setHeader('Set-Cookie', pieces.join('; '))
}

function clearSessionCookie(res) {
  const pieces = [`${SESSION_COOKIE}=`, 'Path=/api/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (isProduction) pieces.push('Secure')
  res.setHeader('Set-Cookie', pieces.join('; '))
}

function originIsAllowed(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  try {
    const expected = config.admin.origin
      ? new URL(config.admin.origin).origin
      : `${req.secure ? 'https' : 'http'}://${req.get('host')}`
    return new URL(origin).origin === expected
  } catch {
    return false
  }
}

function safeEqualHex(first, second) {
  if (!/^[a-f0-9]{64}$/i.test(first || '') || !/^[a-f0-9]{64}$/i.test(second || '')) return false
  const left = Buffer.from(first, 'hex')
  const right = Buffer.from(second, 'hex')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function requireAdmin(req, res, next) {
  try {
    const token = cookieToken(req)
    if (!token) return fail(res, 401, '请先登录管理后台')
    const session = await adminFromSession(token)
    if (!session) {
      clearSessionCookie(res)
      return fail(res, 401, '管理会话已过期，请重新登录')
    }
    req.admin = session
    req.adminToken = token
    next()
  } catch {
    return fail(res, 503, '管理服务暂不可用')
  }
}

function requireCsrf(req, res, next) {
  if (!originIsAllowed(req)) return fail(res, 403, '请求来源校验失败')
  const suppliedHash = hashAdminToken(String(req.headers['x-csrf-token'] || ''))
  if (!safeEqualHex(req.admin.csrf_hash, suppliedHash)) return fail(res, 403, '安全校验失败，请刷新后台后重试')
  next()
}

function identityHash(req) {
  return crypto.createHash('sha256').update(String(req.ip || 'unknown')).digest('hex')
}

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value || ''))
}

export function createAdminRouter() {
  const router = express.Router()

  router.post('/login', async (req, res) => {
    if (!originIsAllowed(req)) return fail(res, 403, '请求来源校验失败')
    const username = String(req.body?.username || '').trim().slice(0, 80)
    const password = String(req.body?.password || '')
    if (!username || !password || password.length > 1024) return fail(res, 400, '请输入管理员账号和密码')
    try {
      const identity = identityHash(req)
      if (await countAdminLoginAttempts(identity) >= 10) return fail(res, 429, '登录尝试过多，请15分钟后再试')
      const admin = await getAdminByUsername(username)
      const matches = admin && !admin.disabled
        ? await verifyPassword(password, admin.password_hash)
        : await verifyPassword(password, 'scrypt$invalidsalt$' + '0'.repeat(128))
      await recordAdminLoginAttempt(identity, Boolean(matches))
      if (!admin || admin.disabled || !matches) return fail(res, 401, '账号或密码错误')
      const session = await createAdminSession(admin.id)
      await markAdminLogin(admin.id)
      setSessionCookie(res, session.token, session.expiresAt.getTime() - Date.now())
      return ok(res, { username: admin.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() })
    } catch (error) {
      console.error(`[admin] login failed: ${error.code || error.name || 'database'}`)
      return fail(res, 503, '管理登录服务暂不可用')
    }
  })

  router.use(requireAdmin)

  router.get('/session', async (req, res) => {
    try {
      const csrfToken = await rotateAdminCsrf(req.adminToken)
      if (!csrfToken) return fail(res, 401, '管理会话已过期，请重新登录')
      return ok(res, { username: req.admin.username, csrfToken })
    } catch {
      return fail(res, 503, '管理会话暂不可用')
    }
  })

  router.post('/logout', requireCsrf, async (req, res) => {
    try {
      await deleteAdminSession(req.adminToken)
      clearSessionCookie(res)
      return ok(res, { loggedOut: true })
    } catch {
      return fail(res, 503, '退出登录失败')
    }
  })

  router.get('/overview', async (req, res) => {
    try {
      const [batches, users, transactions, audit] = await Promise.all([
        listAdminBatches(), searchAdminUsers(''), listAdminTransactions(), listAdminAudit()
      ])
      return ok(res, { batchCount: batches.length, userCount: users.length, transactions, audit })
    } catch {
      return fail(res, 503, '后台数据暂不可用')
    }
  })

  router.get('/users', async (req, res) => {
    try {
      return ok(res, { users: await searchAdminUsers(req.query.q) })
    } catch {
      return fail(res, 503, '用户列表暂不可用')
    }
  })

  router.get('/users/:userId', async (req, res) => {
    if (String(req.params.userId || '').length > 36) return fail(res, 400, '用户编号无效')
    try {
      const user = await getAdminUserDetail(req.params.userId)
      if (!user) return fail(res, 404, '用户不存在')
      return ok(res, user)
    } catch {
      return fail(res, 503, '用户详情暂不可用')
    }
  })

  router.get('/users/:userId/custom-access', async (req, res) => {
    if (!validId(req.params.userId)) return fail(res, 400, '用户编号无效')
    try {
      return ok(res, await getCustomAccess(req.params.userId))
    } catch {
      return fail(res, 503, '人工服务权限暂不可用')
    }
  })

  router.post('/users/:userId/custom-access', requireCsrf, async (req, res) => {
    if (!validId(req.params.userId)) return fail(res, 400, '用户编号无效')
    try {
      return ok(res, await updateCustomAccess({
        adminId: req.admin.id, userId: req.params.userId,
        merchant: req.body?.merchant, tester: req.body?.tester
      }))
    } catch (error) {
      if (error.status) return fail(res, error.status, error.message)
      return fail(res, 503, '人工服务权限修改失败')
    }
  })

  router.post('/custom-orders/:orderId/refund', requireCsrf, async (req, res) => {
    if (!validId(req.params.orderId)) return fail(res, 400, '工单编号无效')
    try {
      return ok(res, await adminRefundCustomOrder({
        adminId: req.admin.id, orderId: req.params.orderId,
        reason: req.body?.reason
      }))
    } catch (error) {
      if (error.status) return fail(res, error.status, error.message)
      return fail(res, 503, '特殊退款失败')
    }
  })

  router.get('/batches', async (req, res) => {
    try {
      return ok(res, { batches: await listAdminBatches() })
    } catch {
      return fail(res, 503, '兑换码批次暂不可用')
    }
  })

  router.get('/codes', async (req, res) => {
    try {
      return ok(res, { codes: await listAdminCodes({ batchId: req.query.batchId, status: req.query.status }) })
    } catch {
      return fail(res, 503, '兑换码列表暂不可用')
    }
  })

  router.post('/batches', requireCsrf, async (req, res) => {
    const count = Number(req.body?.count)
    const note = String(req.body?.note || '').trim()
    const expiresAtValue = String(req.body?.expiresAt || '').trim()
    let expiresAt = null
    if (expiresAtValue) {
      const parsed = new Date(expiresAtValue)
      if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) return fail(res, 400, '兑换截止时间必须是未来时间')
      expiresAt = parsed
    }
    try {
      const batch = await createCodeBatch({
        adminId: req.admin.id,
        planId: String(req.body?.productId || ''),
        count,
        note,
        expiresAt
      })
      return res.status(201).json(batch)
    } catch (error) {
      if (/请选择|每批|商品不存在/.test(error.message || '')) return fail(res, 400, error.message)
      console.error(`[admin] batch create failed: ${error.code || error.name || 'database'}`)
      return fail(res, 503, '兑换码批次创建失败')
    }
  })

  router.post('/batches/:batchId/disable', requireCsrf, async (req, res) => {
    const batchId = req.params.batchId
    if (!validId(batchId)) return fail(res, 400, '批次编号无效')
    try {
      const disabledCount = await disableAdminBatch({ adminId: req.admin.id, batchId })
      return ok(res, { disabledCount })
    } catch {
      return fail(res, 503, '停用批次失败')
    }
  })

  router.post('/codes/:codeId/disable', requireCsrf, async (req, res) => {
    const codeId = req.params.codeId
    if (!validId(codeId)) return fail(res, 400, '兑换码编号无效')
    try {
      const disabled = await disableAdminCode({ adminId: req.admin.id, codeId })
      if (!disabled) return fail(res, 409, '兑换码已兑换、停用或不存在')
      return ok(res, { disabled: true })
    } catch {
      return fail(res, 503, '停用兑换码失败')
    }
  })

  router.post('/batches/:batchId/exported', requireCsrf, async (req, res) => {
    const batchId = req.params.batchId
    if (!validId(batchId)) return fail(res, 400, '批次编号无效')
    try {
      await recordCodeExport({ adminId: req.admin.id, batchId, count: req.body?.count })
      return ok(res, { audited: true })
    } catch {
      return fail(res, 503, '导出审计记录失败')
    }
  })

  router.get('/audit', async (req, res) => {
    try {
      return ok(res, { audit: await listAdminAudit() })
    } catch {
      return fail(res, 503, '操作记录暂不可用')
    }
  })

  router.get('/transactions', async (req, res) => {
    try {
      return ok(res, { transactions: await listAdminTransactions() })
    } catch {
      return fail(res, 503, '交易记录暂不可用')
    }
  })

  // Express async-route errors do not reveal SQL, file paths, or credential details.
  router.use((error, req, res, next) => {
    console.error(`[admin] request failed: ${error.code || error.name || 'unknown'}`)
    if (res.headersSent) return next(error)
    return fail(res, 500, '后台请求失败')
  })
  return router
}
