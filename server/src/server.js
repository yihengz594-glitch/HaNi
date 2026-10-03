import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config, assertLiveConfig } from './config.js'
import {
  applyWechatPayment,
  completeGenerationTask,
  createPaymentOrder,
  createSession,
  getCreditBalance,
  getAccountHistory,
  getGenerationTask,
  getGenerationTaskByKey,
  getMembershipProfile,
  getPublicProducts,
  getOrderForUser,
  getPlan,
  failGenerationTask,
  recoverAbandonedGenerationTasks,
  redeemCode,
  reserveGenerationTask,
  setPrepayId,
  upsertUser,
  userFromSession,
  writePaymentLog
} from './store.js'
import { createJsapiOrder, makePaymentParams, queryByOutTradeNo, verifyAndDecryptNotification } from './wechat-pay.js'
import { parseImageUpload, validateImageSignature } from './multipart-image.js'
import { runPatternJob } from './pattern-runner.js'
import { createAdminRouter } from './admin.js'
import { createCustomRouter } from './custom-router.js'
import { assertStorageConfigured, commercialSettings } from './custom-rules.js'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

const ok = (res, data) => res.status(200).json(data)
const fail = (res, status, message) => res.status(status).json({ error: message, message })

function requestId(req) {
  return req.headers['x-request-id'] || crypto.randomUUID()
}

function idempotencyKey(req) {
  const value = String(req.headers['idempotency-key'] || '').trim()
  if (!value) return crypto.randomUUID()
  if (value.length > 128) throw new Error('Idempotency-Key 过长')
  return value
}

async function requireUser(req, res, next) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) return fail(res, 401, '缺少会话令牌')
  try {
    const user = await userFromSession(token)
    if (!user) return fail(res, 401, '会话已过期，请重新登录')
    req.user = user
    req.sessionToken = token
    next()
  } catch (error) {
    return fail(res, 503, '会员服务暂不可用')
  }
}

app.get('/health', (req, res) => ok(res, {
  ok: true,
  service: 'pinbead-membership-server',
  paymentMode: config.paymentMode
}))

app.post('/api/pay/notify', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const id = requestId(req)
  try {
    if (config.paymentMode !== 'live') return fail(res, 503, '支付服务处于安全测试模式')
    const resource = verifyAndDecryptNotification(req.headers, req.body)
    if (resource.appid !== config.wx.appid || resource.mchid !== config.wx.mchid) {
      throw new Error('微信支付回调 appid 或 mchid 不匹配')
    }
    if (!resource.out_trade_no || !resource.transaction_id || !resource.amount || resource.amount.currency !== 'CNY') {
      throw new Error('微信支付回调订单字段不完整')
    }
    const result = await applyWechatPayment({
      notificationId: crypto.createHash('sha256').update(req.body).digest('hex'),
      outTradeNo: resource.out_trade_no,
      transactionId: resource.transaction_id,
      amountFen: resource.amount && resource.amount.total,
      tradeState: resource.trade_state,
      resource
    })
    return ok(res, { code: 'SUCCESS', message: '成功', result })
  } catch (error) {
    console.error(`[${id}] payment notify rejected: ${error.message}`)
    await writePaymentLog({
      requestId: id,
      level: 'ERROR',
      eventType: 'PAYMENT_NOTIFY_FAILED',
      message: error.message
    })
    return fail(res, 500, '回调处理失败')
  }
})

app.use(express.json({ limit: '32kb' }))
app.use('/api/custom', createCustomRouter(requireUser))

app.get('/api/products', async (req, res) => {
  try {
    return ok(res, { products: await getPublicProducts() })
  } catch (error) {
    console.error(`[${requestId(req)}] product catalog unavailable: ${error.code || error.name || 'database'}`)
    return fail(res, 503, '商品配置暂不可用')
  }
})

app.post('/api/auth/login', async (req, res) => {
  const id = requestId(req)
  try {
    if (!config.databaseUrl || !config.wx.appid || !config.wx.secret) {
      return fail(res, 503, '登录服务未配置数据库或微信登录凭据')
    }
    const code = String(req.body && req.body.code || '').trim()
    if (!code) return fail(res, 400, '缺少微信登录 code')
    const query = new URLSearchParams({
      appid: config.wx.appid,
      secret: config.wx.secret,
      js_code: code,
      grant_type: 'authorization_code'
    })
    const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query}`)
    const data = await response.json()
    if (!response.ok || data.errcode || !data.openid) throw new Error(data.errmsg || '微信登录失败')
    const user = await upsertUser({ appid: config.wx.appid, openid: data.openid, unionid: data.unionid })
    const session = await createSession(user.id)
    return ok(res, { token: session.token, expiresAt: session.expiresAt.toISOString() })
  } catch (error) {
    console.error(`[${id}] login failed: ${error.message}`)
    return fail(res, 503, '登录服务暂不可用')
  }
})

app.get('/api/membership/me', requireUser, async (req, res) => {
  try {
    return ok(res, { memberProfile: await getMembershipProfile(req.user.id) })
  } catch {
    return fail(res, 503, '会员服务暂不可用')
  }
})

app.get('/api/account/history', requireUser, async (req, res) => {
  try {
    return ok(res, { history: await getAccountHistory(req.user.id) })
  } catch {
    return fail(res, 503, '账户记录暂不可用')
  }
})

app.post('/api/pay/orders', requireUser, async (req, res) => {
  const id = requestId(req)
  try {
    if (config.paymentMode !== 'live') return fail(res, 503, '支付服务处于安全测试模式，不会创建真实订单')
    assertLiveConfig()
    const planId = String(req.body && (req.body.productId || req.body.planId) || '').trim()
    const plan = await getPlan(planId)
    if (!plan) return fail(res, 400, '商品不存在或已下架')
    const requestKey = idempotencyKey(req)
    const outTradeNo = `PB${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`.slice(0, 32)
    const expireAt = new Date(Date.now() + 15 * 60 * 1000)
    const created = await createPaymentOrder({
      userId: req.user.id,
      planId,
      outTradeNo,
      expireAt,
      idempotencyKey: requestKey
    })
    if (created.order.status === 'PAID') {
      return ok(res, {
        orderNo: created.order.out_trade_no,
        status: 'PAID',
        paid: true,
        memberProfile: await getMembershipProfile(req.user.id)
      })
    }
    if (created.order.expire_at && new Date(created.order.expire_at).getTime() <= Date.now()) {
      return fail(res, 409, '该订单已过期，请重新点击购买')
    }
    if (created.order.prepay_id) {
      return ok(res, {
        orderNo: created.order.out_trade_no,
        payment: makePaymentParams(created.order.prepay_id),
        reused: true
      })
    }
    const wxOrder = await createJsapiOrder({
      outTradeNo: created.order.out_trade_no,
      description: `拼豆高级版${plan.name}`,
      amountFen: created.plan.amount_fen,
      openid: req.user.openid,
      timeExpire: expireAt.toISOString()
    })
    await setPrepayId(created.order.out_trade_no, wxOrder.prepay_id)
    return ok(res, { orderNo: created.order.out_trade_no, payment: makePaymentParams(wxOrder.prepay_id) })
  } catch (error) {
    console.error(`[${id}] order create failed: ${error.message}`)
    await writePaymentLog({
      requestId: id,
      level: 'ERROR',
      eventType: 'ORDER_CREATE_FAILED',
      message: error.message
    })
    if (error.code === 'PERMANENT_ALREADY_ACTIVE' || error.code === 'PERMANENT_ORDER_PENDING') {
      return fail(res, 409, error.message)
    }
    return fail(res, 503, '支付订单创建失败')
  }
})

app.get('/api/pay/orders/:outTradeNo', requireUser, async (req, res) => {
  const id = requestId(req)
  try {
    if (config.paymentMode !== 'live') return fail(res, 503, '支付服务处于安全测试模式')
    assertLiveConfig()
    const order = await getOrderForUser(req.params.outTradeNo, req.user.id)
    if (!order) return fail(res, 404, '订单不存在')
    const remote = await queryByOutTradeNo(order.out_trade_no)
    if (remote.trade_state === 'SUCCESS') {
      if (remote.appid !== config.wx.appid || remote.mchid !== config.wx.mchid) {
        throw new Error('查单返回的 appid 或 mchid 不匹配')
      }
      if (!remote.amount || Number(remote.amount.total) !== Number(order.amount_fen)) {
        throw new Error('查单返回金额与本地订单不匹配')
      }
      const queryNotificationId = `q${crypto.createHash('sha256').update(JSON.stringify({
        outTradeNo: order.out_trade_no,
        transactionId: remote.transaction_id || '',
        tradeState: remote.trade_state
      })).digest('hex').slice(0, 63)}`
      const applied = await applyWechatPayment({
        notificationId: queryNotificationId,
        outTradeNo: order.out_trade_no,
        transactionId: remote.transaction_id,
        amountFen: remote.amount.total,
        tradeState: remote.trade_state,
        resource: remote
      })
      return ok(res, {
        orderNo: order.out_trade_no,
        status: 'SUCCESS',
        tradeState: remote.trade_state,
        paid: true,
        applied,
        memberProfile: await getMembershipProfile(req.user.id)
      })
    }
    return ok(res, {
      orderNo: order.out_trade_no,
      status: remote.trade_state || order.status,
      tradeState: remote.trade_state,
      paid: remote.trade_state === 'SUCCESS'
    })
  } catch (error) {
    console.error(`[${id}] order query failed: ${error.message}`)
    await writePaymentLog({
      requestId: id,
      outTradeNo: req.params.outTradeNo,
      level: 'ERROR',
      eventType: 'ORDER_QUERY_FAILED',
      message: error.message
    })
    return fail(res, 503, '支付订单查询失败')
  }
})

app.get('/api/quota/me', requireUser, async (req, res) => {
  try {
    return ok(res, {
      creditsRemaining: await getCreditBalance(req.user.id),
      memberProfile: await getMembershipProfile(req.user.id)
    })
  } catch {
    return fail(res, 503, '额度服务暂不可用')
  }
})

app.post('/api/pattern/tasks', requireUser, express.raw({ type: 'multipart/form-data', limit: '9mb' }), async (req, res) => {
  let reservedTask = null
  try {
    if (!req.body || !Buffer.isBuffer(req.body)) return fail(res, 400, '缺少上传图片')
    const requestKey = idempotencyKey(req)
    const { imageBuffer, fields } = parseImageUpload(req.headers['content-type'], req.body)
    validateImageSignature(imageBuffer)
    if (fields.taskType !== 'DIRECT_PATTERN') return fail(res, 501, '此类生成服务尚未接入')
    const submitted = JSON.parse(fields.settings || '{}')
    const paletteValues = new Set(['72', '96', '144', '221', '238', '291'])
    const thresholds = new Set(['none', 'light', 'medium', 'strong', 'veryStrong'])
    const bound = (value, fallback) => Math.max(8, Math.min(160, Math.round(Number(value) || fallback)))
    const settings = {
      sizeMode: submitted.sizeMode === 'image' ? 'image' : 'board',
      gridWidth: bound(submitted.gridWidth, 64),
      gridHeight: bound(submitted.gridHeight, 64),
      paletteSpec: paletteValues.has(String(submitted.paletteSpec)) ? String(submitted.paletteSpec) : '221',
      threshold: thresholds.has(String(submitted.threshold)) ? String(submitted.threshold) : 'none'
    }
    const requestHash = crypto.createHash('sha256')
      .update(imageBuffer)
      .update('\0')
      .update(JSON.stringify(settings))
      .digest('hex')
    const reservation = await reserveGenerationTask({
      userId: req.user.id,
      idempotencyKey: requestKey,
      requestHash,
      settings
    })
    if (!reservation.allowed) return fail(res, 402, '生成次数不足，请先购买次数')
    reservedTask = reservation

    if (reservation.status === 'SUCCEEDED') {
      return ok(res, {
        taskId: reservation.taskId,
        status: reservation.status,
        result: reservation.result,
        creditsRemaining: reservation.creditsRemaining,
        duplicate: true
      })
    }
    if (reservation.status === 'FAILED') {
      return fail(res, 422, '该生成任务已失败，请重新发起生成')
    }
    if (reservation.duplicate) {
      return res.status(202).json({ taskId: reservation.taskId, status: reservation.status, duplicate: true })
    }

    const taskId = reservation.taskId
    void runPatternJob(imageBuffer, settings)
      .then((result) => completeGenerationTask({ taskId, userId: req.user.id, result }))
      .catch(async (error) => {
        const errorCode = error && error.code ? error.code : 'PATTERN_PROCESSING_FAILED'
        try {
          await failGenerationTask({ taskId, userId: req.user.id, errorCode })
        } catch (settlementError) {
          console.error(`[task:${taskId}] settlement deferred: ${settlementError.code || settlementError.name || 'database'}`)
        }
        console.error(`[task:${taskId}] failed: ${errorCode}`)
      })
    return res.status(202).json({
      taskId,
      status: 'PROCESSING',
      billingMode: reservation.billingMode,
      creditCost: reservation.creditCost,
      creditsRemaining: reservation.creditsRemaining
    })
  } catch (error) {
    if (reservedTask && reservedTask.taskId) {
      try {
        await failGenerationTask({ taskId: reservedTask.taskId, userId: req.user.id, errorCode: error.code || 'UPLOAD_FAILED' })
      } catch {}
    }
    if (error.code === 'IDEMPOTENCY_CONFLICT') return fail(res, 409, error.message)
    if (error.code === 'QUEUE_FULL') return fail(res, 503, '生成队列繁忙，请稍后重试')
    if (error.code === 'BAD_UPLOAD' || error.code === 'IMAGE_SIZE' || error.code === 'IMAGE_TYPE') {
      return fail(res, 400, error.message)
    }
    if (error instanceof SyntaxError) return fail(res, 400, '生成参数格式不正确')
    console.error(`[${requestId(req)}] pattern task rejected: ${error.code || error.name || 'unknown'}`)
    return fail(res, 503, '图纸生成服务暂不可用')
  }
})

app.get('/api/pattern/tasks/by-key/:idempotencyKey', requireUser, async (req, res) => {
  try {
    const task = await getGenerationTaskByKey({ idempotencyKey: req.params.idempotencyKey, userId: req.user.id })
    if (!task) return fail(res, 404, '生成任务不存在')
    return ok(res, {
      taskId: task.id,
      status: task.status,
      billingMode: task.billing_mode,
      creditCost: Number(task.credit_cost),
      result: task.result_json,
      errorCode: task.error_code,
      memberProfile: await getMembershipProfile(req.user.id)
    })
  } catch {
    return fail(res, 503, '生成任务状态暂不可用')
  }
})

app.get('/api/pattern/tasks/:taskId', requireUser, async (req, res) => {
  try {
    const task = await getGenerationTask({ taskId: req.params.taskId, userId: req.user.id })
    if (!task) return fail(res, 404, '生成任务不存在')
    return ok(res, {
      taskId: task.id,
      status: task.status,
      billingMode: task.billing_mode,
      creditCost: Number(task.credit_cost),
      result: task.result_json,
      errorCode: task.error_code,
      memberProfile: await getMembershipProfile(req.user.id)
    })
  } catch {
    return fail(res, 503, '生成任务状态暂不可用')
  }
})

app.post('/api/quota/consume', requireUser, (req, res) => {
  return fail(res, 410, '此扣次接口已停用，请通过服务端图纸任务获取结果')
})

app.post('/api/membership/redeem', requireUser, async (req, res) => {
  const id = requestId(req)
  try {
    const code = String(req.body && req.body.code || '').trim()
    if (!code || code.length > 64) return fail(res, 400, '兑换码格式不正确')
    const requestKey = idempotencyKey(req)
    const sourceHash = crypto.createHash('sha256').update(String(req.ip || 'unknown')).digest('hex')
    const result = await redeemCode({ userId: req.user.id, code, idempotencyKey: requestKey, sourceHash })
    return ok(res, { ...result, memberProfile: await getMembershipProfile(req.user.id) })
  } catch (error) {
    if (error.code === 'REDEEM_RATE_LIMITED') return fail(res, 429, error.message)
    if (error.code === 'PERMANENT_ALREADY_ACTIVE') return fail(res, 409, error.message)
    if (error.code === 'PERMANENT_ORDER_PENDING') return fail(res, 409, error.message)
    if (error.code === 'IDEMPOTENCY_CONFLICT') return fail(res, 409, error.message)
    if (error.code === 'REDEEM_INVALID') return fail(res, 400, error.message)
    console.error(`[${id}] redeem failed: ${error.code || error.name || 'unknown'}`)
    return fail(res, 503, '兑换服务暂不可用，请稍后重试')
  }
})

app.use('/api/admin', createAdminRouter())

app.use('/admin', express.static(fileURLToPath(new URL('../public/admin/', import.meta.url)), {
  index: 'index.html',
  etag: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}))

app.use((req, res) => fail(res, 404, '接口不存在'))

app.use((error, req, res, next) => {
  console.error(`[${requestId(req)}] unhandled: ${error.message}`)
  if (res.headersSent) return next(error)
  return fail(res, 500, '服务端错误')
})

if (config.paymentMode === 'live') {
  try {
    assertLiveConfig()
  } catch (error) {
    console.error(`PAYMENT_MODE=live 但配置不完整: ${error.message}`)
    process.exit(1)
  }
}

if (config.custom.mode === 'live') {
  try {
    commercialSettings()
    assertStorageConfigured()
  } catch (error) {
    console.error(`CUSTOM_SERVICE_MODE=live 但配置不完整: ${error.message}`)
    process.exit(1)
  }
}

app.listen(config.port, () => {
  console.log(`pinbead membership server listening on :${config.port} (${config.paymentMode})`)
})

if (config.databaseUrl) {
  const recoveryTimer = setInterval(() => {
    recoverAbandonedGenerationTasks().catch((error) => {
      console.error(`[task-recovery] sweep failed: ${error.code || error.name || 'database'}`)
    })
  }, 60_000)
  recoveryTimer.unref()
  recoverAbandonedGenerationTasks().catch((error) => {
    console.error(`[task-recovery] startup sweep failed: ${error.code || error.name || 'database'}`)
  })
}
