import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const envFile = process.env.ENV_FILE || '.env.local'
dotenv.config({ path: envFile })

const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: numberFromEnv('PORT', 3000),
  paymentMode: process.env.PAYMENT_MODE || 'mock',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionTtlDays: numberFromEnv('SESSION_TTL_DAYS', 30),
  custom: {
    mode: process.env.CUSTOM_SERVICE_MODE || 'disabled',
    creditCost: process.env.CUSTOM_CREDIT_COST === undefined || process.env.CUSTOM_CREDIT_COST === ''
      ? null : numberFromEnv('CUSTOM_CREDIT_COST', null),
    commercialRulesApproved: process.env.CUSTOM_COMMERCIAL_RULES_APPROVED === 'true',
    permanentPolicy: process.env.CUSTOM_PERMANENT_POLICY || 'excluded',
    legacyMemberPolicy: process.env.CUSTOM_LEGACY_MEMBER_POLICY || 'excluded',
    storageRoot: process.env.CUSTOM_STORAGE_ROOT || '',
    deliveryDays: numberFromEnv('CUSTOM_DELIVERY_DAYS', 7),
    includedRevisions: numberFromEnv('CUSTOM_INCLUDED_REVISIONS', 1),
    retentionDays: numberFromEnv('CUSTOM_RETENTION_DAYS', 30),
    orderTimeoutDays: numberFromEnv('CUSTOM_ORDER_TIMEOUT_DAYS', 60)
  },
  admin: {
    bootstrapUsername: process.env.ADMIN_BOOTSTRAP_USERNAME || '',
    bootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
    sessionHours: numberFromEnv('ADMIN_SESSION_HOURS', 8),
    origin: process.env.ADMIN_ORIGIN || ''
  },
  wx: {
    appid: process.env.WX_APPID || '',
    secret: process.env.WX_SECRET || '',
    mchid: process.env.WX_MCHID || '',
    notifyUrl: process.env.WX_NOTIFY_URL || '',
    apiV3Key: process.env.WX_API_V3_KEY || '',
    merchantCertificateSerialNo: process.env.WX_MCH_CERT_SERIAL_NO || '',
    merchantPrivateKeyPath: process.env.WX_MCH_PRIVATE_KEY_PATH || '',
    platformPublicKeyPath: process.env.WX_PAY_PLATFORM_PUBLIC_KEY_PATH || '',
    platformSerialNo: process.env.WX_PAY_PLATFORM_SERIAL_NO || '',
    apiHost: process.env.WX_API_HOST || 'https://api.mch.weixin.qq.com'
  }
}

export const isProduction = config.nodeEnv === 'production'

export function resolveSecretPath(secretPath) {
  if (!secretPath) return ''
  return path.isAbsolute(secretPath) ? secretPath : path.resolve(process.cwd(), secretPath)
}

export function assertLiveConfig() {
  const required = [
    ['DATABASE_URL', config.databaseUrl],
    ['WX_APPID', config.wx.appid],
    ['WX_SECRET', config.wx.secret],
    ['WX_MCHID', config.wx.mchid],
    ['WX_NOTIFY_URL', config.wx.notifyUrl],
    ['WX_API_V3_KEY', config.wx.apiV3Key],
    ['WX_MCH_CERT_SERIAL_NO', config.wx.merchantCertificateSerialNo],
    ['WX_MCH_PRIVATE_KEY_PATH', config.wx.merchantPrivateKeyPath],
    ['WX_PAY_PLATFORM_PUBLIC_KEY_PATH', config.wx.platformPublicKeyPath]
  ]
  const missing = required.filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) {
    throw new Error(`live 支付配置缺少: ${missing.join(', ')}`)
  }
  if (!config.wx.notifyUrl.startsWith('https://')) {
    throw new Error('WX_NOTIFY_URL 必须使用 HTTPS')
  }
  if (Buffer.byteLength(config.wx.apiV3Key, 'utf8') !== 32) {
    throw new Error('WX_API_V3_KEY 必须是 32 字节')
  }
  if (!fs.existsSync(resolveSecretPath(config.wx.merchantPrivateKeyPath))) {
    throw new Error('商户私钥文件不存在或不可读')
  }
  if (!fs.existsSync(resolveSecretPath(config.wx.platformPublicKeyPath))) {
    throw new Error('微信支付平台公钥文件不存在或不可读')
  }
}
