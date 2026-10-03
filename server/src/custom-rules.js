import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config, isProduction } from './config.js'

export const STATUS_LABELS = Object.freeze({
  PENDING_ACCEPT: '待接单', IN_PROGRESS: '制作中', WAIT_Q_CONFIRM: '待确认Q图',
  REVISION: '修改中', WAIT_DELIVERY: '待交付图纸', COMPLETED: '已完成',
  CANCELLED: '已取消', REJECTED: '已拒单', SYSTEM_FAILED: '系统失败'
})
export const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'REJECTED', 'SYSTEM_FAILED'])

export class CustomError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message)
    this.status = status
    this.code = code
  }
}

export function commercialSettings() {
  const c = config.custom
  if (!['disabled', 'test', 'live'].includes(c.mode)) throw new Error('CUSTOM_SERVICE_MODE 无效')
  if (c.creditCost !== null && (!Number.isSafeInteger(c.creditCost) || c.creditCost < 0 || c.creditCost > 1000)) {
    throw new Error('CUSTOM_CREDIT_COST 必须为 0-1000 的整数')
  }
  if (c.mode === 'live' && (!c.commercialRulesApproved || !Number.isSafeInteger(c.creditCost) || c.creditCost < 1 ||
    c.permanentPolicy !== 'excluded' || c.legacyMemberPolicy !== 'excluded')) {
    throw new Error('人工服务商业规则未确认；正式模式仅支持明确单价且旧权益不自动覆盖')
  }
  if (![c.deliveryDays, c.includedRevisions, c.retentionDays, c.orderTimeoutDays].every((n) => Number.isSafeInteger(n) && n >= 0) || c.retentionDays < 1 || c.orderTimeoutDays < 1) {
    throw new Error('人工服务时效或保留期限配置无效')
  }
  return c
}

export function assertStorageConfigured() {
  const root = commercialSettings().storageRoot
  if (!root || !path.isAbsolute(root) || root === path.parse(root).root) throw new Error('CUSTOM_STORAGE_ROOT 必须是专用绝对目录')
  const normalized = path.resolve(root)
  let ancestor = normalized
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const resolved = path.join(fs.realpathSync(ancestor), path.relative(ancestor, normalized))
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  if (resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`)) throw new Error('私有文件目录不能位于项目内')
  const tempRoot = fs.realpathSync(os.tmpdir())
  if (isProduction && ([tempRoot, '/private/tmp', '/tmp'].some((candidate) =>
    resolved === candidate || resolved.startsWith(`${candidate}${path.sep}`)))) throw new Error('生产不能使用临时目录存储照片')
  if (fs.existsSync(resolved) && (fs.statSync(resolved).mode & 0o077) !== 0) throw new Error('私有文件目录权限必须为 0700')
  return resolved
}

export function validateRequirements(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CustomError('请填写定制需求')
  const persons = Number(input.persons)
  const clean = (value, max) => String(value || '').trim().slice(0, max)
  if (!Number.isInteger(persons) || persons < 1 || persons > 8) throw new CustomError('人数需为 1-8 人')
  const result = {
    persons,
    style: clean(input.style, 120),
    features: clean(input.features, 600),
    size: clean(input.size, 80),
    notes: clean(input.notes, 800),
    minorInPhoto: input.minorInPhoto === true,
    guardianConfirmed: input.guardianConfirmed === true
  }
  if (!result.style || !result.features || !result.size) throw new CustomError('请填写风格、保留特征和尺寸')
  if (result.minorInPhoto && !result.guardianConfirmed) throw new CustomError('未成年人照片须由监护人确认')
  if (input.consentHumanThirdParty !== true || input.confirmTerms !== true) throw new CustomError('请先确认人工处理、扣次和照片规则')
  result.consentHumanThirdParty = true
  result.confirmTerms = true
  result.consentVersion = 'manual-q-v1'
  return result
}

export function hashRequest(requirements, sourceFileId) {
  return crypto.createHash('sha256').update(JSON.stringify({ requirements, sourceFileId })).digest('hex')
}

export function canReadOrder(order, userId, merchant) {
  return Boolean(order && (order.user_id === userId || merchant))
}

export function canUploadOrderFile(order, userId, merchant, kind) {
  if (!canReadOrder(order, userId, merchant) || TERMINAL.has(order.status)) return false
  if (kind === 'CHAT') return order.user_id === userId || merchant
  return Boolean(merchant && order.user_id !== userId && ['Q_PREVIEW', 'Q_FINAL', 'PATTERN', 'COLORS'].includes(kind))
}

export function billingTransition(order, action) {
  const reserved = Number(order.reserved_credits)
  if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error('工单预占次数无效')
  return {
    release: ['reject', 'cancel', 'system_fail'].includes(action) ? reserved : 0,
    settle: action === 'deliver' ? reserved : 0
  }
}

export function nextStatus(current, action, role, hasFiles = {}) {
  const map = {
    accept: ['PENDING_ACCEPT', 'MERCHANT', 'IN_PROGRESS'],
    reject: ['PENDING_ACCEPT,IN_PROGRESS,REVISION,WAIT_Q_CONFIRM,WAIT_DELIVERY', 'MERCHANT', 'REJECTED'],
    cancel: ['PENDING_ACCEPT', 'CUSTOMER', 'CANCELLED'],
    preview: ['IN_PROGRESS,REVISION', 'MERCHANT', 'WAIT_Q_CONFIRM'],
    approve: ['WAIT_Q_CONFIRM', 'CUSTOMER', 'WAIT_DELIVERY'],
    revise: ['WAIT_Q_CONFIRM', 'CUSTOMER', 'REVISION'],
    deliver: ['WAIT_DELIVERY', 'MERCHANT', 'COMPLETED'],
    system_fail: ['PENDING_ACCEPT,IN_PROGRESS,REVISION,WAIT_Q_CONFIRM,WAIT_DELIVERY', 'SYSTEM', 'SYSTEM_FAILED']
  }
  const rule = map[action]
  if (!rule || !rule[0].split(',').includes(current) || rule[1] !== role) {
    throw new CustomError('当前状态不允许此操作', 409, 'INVALID_TRANSITION')
  }
  if (action === 'preview' && !hasFiles.preview) throw new CustomError('请先上传Q图预览')
  if (action === 'deliver' && !(hasFiles.finalQ && hasFiles.pattern && hasFiles.colors)) {
    throw new CustomError('最终Q图、高清施工图和用色清单必须齐全')
  }
  return rule[2]
}
