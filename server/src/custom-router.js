import express from 'express'
import { config } from './config.js'
import { parseCustomMultipart, readPrivateFile, removePrivateFile, validateCustomImage, writePrivateFile } from './custom-files.js'
import {
  actOnCustomOrder, createCustomOrder, createStagedFile, failCustomOrderForSystem, getAuthorizedFile, getCustomAccess,
  getCustomOrderDetail, getUploadOrder, listCustomOrders, sendCustomMessage
} from './custom-store.js'
import { assertStorageConfigured, commercialSettings, CustomError } from './custom-rules.js'

const uuid = (value) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value || ''))
const validKey = (req) => {
  const key = String(req.get('Idempotency-Key') || '').trim()
  if (!key || key.length > 128) throw new CustomError('请提供有效的 Idempotency-Key')
  return key
}
const catchRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
const asBoolean = (value) => value === true

export function createCustomRouter(requireUser) {
  const router = express.Router()
  router.use(requireUser)

  router.get('/config', catchRoute(async (req, res) => {
    const settings = commercialSettings()
    const access = await getCustomAccess(req.user.id)
    let storageReady = false
    try { assertStorageConfigured(); storageReady = true } catch {}
    const canSubmit = storageReady && (settings.mode === 'live' || (settings.mode === 'test' && access.tester))
    res.json({
      mode: settings.mode, canSubmit, isMerchant: access.merchant, isTester: access.tester,
      creditCost: canSubmit ? (settings.creditCost ?? 0) : null,
      chargeLabel: canSubmit ? settings.creditCost ? `预占 ${settings.creditCost} 次，交付后正式扣除` : '测试账号试用，不扣次' : '暂未开放接单',
      deliveryDays: settings.deliveryDays, includedRevisions: settings.includedRevisions,
      retentionDays: settings.retentionDays,
      privacyNotice: '照片由商家人工使用第三方图像工具处理；未成年人照片须取得监护人同意。原图和成品仅供本工单使用，未经许可不用于案例展示。'
    })
  }))

  router.post('/files', express.raw({ type: /multipart\/form-data/i, limit: '16mb' }), catchRoute(async (req, res) => {
    const settings = commercialSettings()
    const access = await getCustomAccess(req.user.id)
    const kind = String(req.query.kind || '')
    const orderId = String(req.query.orderId || '')
    if (!['SOURCE', 'CHAT', 'Q_PREVIEW', 'Q_FINAL', 'PATTERN', 'COLORS'].includes(kind)) throw new CustomError('文件用途无效')
    if (kind === 'SOURCE') {
      if (orderId || !(settings.mode === 'live' || (settings.mode === 'test' && access.tester))) throw new CustomError('人工服务暂未对当前账号开放', 403)
    } else {
      if (!uuid(orderId)) throw new CustomError('工单编号无效')
      await getUploadOrder({ orderId, userId: req.user.id, merchant: access.merchant, kind })
    }
    const bytes = parseCustomMultipart(req.get('Content-Type'), req.body)
    const mime = await validateCustomImage(bytes)
    let stored
    try {
      stored = await writePrivateFile(bytes)
    } catch (error) {
      if (orderId) await failCustomOrderForSystem({ orderId, actorId: req.user.id }).catch(() => {})
      throw error
    }
    try {
      const record = await createStagedFile({
        userId: req.user.id, orderId: orderId || null, kind,
        key: stored.key, mime, bytes: bytes.length, sha256: stored.sha256
      })
      res.status(201).json({ file: record })
    } catch (error) {
      await removePrivateFile(stored.key)
      if (orderId) await failCustomOrderForSystem({ orderId, actorId: req.user.id }).catch(() => {})
      throw error
    }
  }))

  router.get('/files/:fileId', catchRoute(async (req, res) => {
    if (!uuid(req.params.fileId)) throw new CustomError('文件编号无效')
    const access = await getCustomAccess(req.user.id)
    const file = await getAuthorizedFile({ fileId: req.params.fileId, userId: req.user.id, merchant: access.merchant })
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mime_type]
    const data = await readPrivateFile(file.storage_key)
    res.set({
      'Content-Type': file.mime_type, 'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="custom-${file.id}.${extension}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
    })
    res.end(data)
  }))

  router.post('/orders', catchRoute(async (req, res) => {
    const settings = commercialSettings()
    const access = await getCustomAccess(req.user.id)
    assertStorageConfigured()
    if (!(settings.mode === 'live' || (settings.mode === 'test' && access.tester))) throw new CustomError('人工服务尚未开放接单', 403)
    if (!uuid(req.body?.sourceFileId)) throw new CustomError('请先上传清晰照片')
    const result = await createCustomOrder({
      userId: req.user.id, key: validKey(req), sourceFileId: req.body.sourceFileId,
      input: req.body?.requirements, service: settings
    })
    res.status(result.reused ? 200 : 201).json({ orderId: result.order.id, status: result.order.status, reused: result.reused })
  }))

  router.get('/orders', catchRoute(async (req, res) => {
    res.json({ orders: await listCustomOrders({ userId: req.user.id }) })
  }))

  router.get('/merchant/orders', catchRoute(async (req, res) => {
    const access = await getCustomAccess(req.user.id)
    if (!access.merchant) throw new CustomError('无商家权限', 403)
    res.json({ orders: await listCustomOrders({ userId: req.user.id, merchant: true }) })
  }))

  router.get('/orders/:orderId', catchRoute(async (req, res) => {
    if (!uuid(req.params.orderId)) throw new CustomError('工单编号无效')
    const access = await getCustomAccess(req.user.id)
    const merchant = req.query.asMerchant === '1' && access.merchant
    res.json(await getCustomOrderDetail({ orderId: req.params.orderId, userId: req.user.id, merchant }))
  }))

  router.post('/orders/:orderId/messages', catchRoute(async (req, res) => {
    if (!uuid(req.params.orderId)) throw new CustomError('工单编号无效')
    const access = await getCustomAccess(req.user.id)
    const merchant = asBoolean(req.body?.asMerchant) && access.merchant
    const fileId = req.body?.fileId || null
    if (fileId && !uuid(fileId)) throw new CustomError('图片编号无效')
    const message = await sendCustomMessage({
      orderId: req.params.orderId, userId: req.user.id, merchant,
      key: validKey(req), body: req.body?.body, fileId
    })
    res.status(201).json({ message })
  }))

  router.post('/orders/:orderId/actions', catchRoute(async (req, res) => {
    if (!uuid(req.params.orderId)) throw new CustomError('工单编号无效')
    const access = await getCustomAccess(req.user.id)
    const merchant = asBoolean(req.body?.asMerchant) && access.merchant
    const action = String(req.body?.action || '')
    if (!['accept', 'reject', 'cancel', 'preview', 'approve', 'revise', 'deliver'].includes(action)) throw new CustomError('操作无效')
    const fileIds = req.body?.fileIds || {}
    if (Object.values(fileIds).some((id) => !uuid(id))) throw new CustomError('文件编号无效')
    const result = await actOnCustomOrder({
      orderId: req.params.orderId, userId: req.user.id, merchant,
      key: validKey(req), action, fileIds, reason: String(req.body?.reason || '')
    })
    res.json({ order: result })
  }))

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error instanceof CustomError) return res.status(error.status).json({ error: error.code, message: error.message })
    if (error.type === 'entity.too.large') return res.status(413).json({ message: '图片超过上传上限' })
    console.error(`[custom] request failed: ${error.code || error.name || 'unknown'}`)
    return res.status(503).json({ message: '人工工单服务暂不可用' })
  })
  return router
}
