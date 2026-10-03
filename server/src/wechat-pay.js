import fs from 'node:fs'
import crypto from 'node:crypto'
import { assertLiveConfig, config, resolveSecretPath } from './config.js'

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json'
}

const readPrivateKey = () => fs.readFileSync(resolveSecretPath(config.wx.merchantPrivateKeyPath))
const readPlatformPublicKey = () => fs.readFileSync(resolveSecretPath(config.wx.platformPublicKeyPath))

function signText(text) {
  return crypto.createSign('RSA-SHA256').update(text).sign(readPrivateKey()).toString('base64')
}

function buildAuthorization(method, pathWithQuery, body) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonceStr}\n${body}\n`
  const signature = signText(message)
  const authorization = [
    'WECHATPAY2-SHA256-RSA2048',
    `mchid="${config.wx.mchid}"`,
    `nonce_str="${nonceStr}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.wx.merchantCertificateSerialNo}"`,
    `signature="${signature}"`
  ].join(',')
  return { authorization, timestamp, nonceStr }
}

async function requestWechatPay(method, pathWithQuery, payload) {
  assertLiveConfig()
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const { authorization } = buildAuthorization(method, pathWithQuery, body)
  const response = await fetch(`${config.wx.apiHost}${pathWithQuery}`, {
    method,
    headers: { ...jsonHeaders, Authorization: authorization },
    body: body || undefined,
    signal: AbortSignal.timeout(15000)
  })
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`微信支付接口 ${response.status}: ${data.message || data.code || '请求失败'}`)
  }
  return data
}

export async function createJsapiOrder({ outTradeNo, description, amountFen, openid, timeExpire }) {
  return requestWechatPay('POST', '/v3/pay/transactions/jsapi', {
    appid: config.wx.appid,
    mchid: config.wx.mchid,
    description,
    out_trade_no: outTradeNo,
    time_expire: timeExpire,
    notify_url: config.wx.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid }
  })
}

export async function queryByOutTradeNo(outTradeNo) {
  return requestWechatPay(
    'GET',
    `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.wx.mchid)}`
  )
}

export function makePaymentParams(prepayId) {
  assertLiveConfig()
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const packageValue = `prepay_id=${prepayId}`
  const message = `${config.wx.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: signText(message)
  }
}

function verifyNotificationSignature(headers, rawBody) {
  const timestamp = String(headers['wechatpay-timestamp'] || '')
  const nonce = String(headers['wechatpay-nonce'] || '')
  const signature = String(headers['wechatpay-signature'] || '')
  const serial = String(headers['wechatpay-serial'] || '')
  if (!timestamp || !nonce || !signature || !serial) {
    throw new Error('微信支付回调签名头不完整')
  }
  const timestampNumber = Number(timestamp)
  if (!Number.isFinite(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) {
    throw new Error('微信支付回调时间戳已过期')
  }
  if (config.wx.platformSerialNo && serial !== config.wx.platformSerialNo) {
    throw new Error('微信支付回调平台证书序列号不匹配')
  }
  const message = `${timestamp}\n${nonce}\n${rawBody.toString()}\n`
  const valid = crypto.createVerify('RSA-SHA256')
    .update(message)
    .verify(readPlatformPublicKey(), Buffer.from(signature, 'base64'))
  if (!valid) throw new Error('微信支付回调签名校验失败')
}

function decryptNotificationResource(resource) {
  if (!resource || resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new Error('不支持的微信支付回调加密算法')
  }
  const key = Buffer.from(config.wx.apiV3Key, 'utf8')
  if (key.length !== 32) throw new Error('WX_API_V3_KEY 必须是 32 字节')
  const ciphertext = Buffer.from(resource.ciphertext, 'base64')
  const authTag = ciphertext.subarray(ciphertext.length - 16)
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'))
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(resource.associated_data || '', 'utf8'))
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
}

export function verifyAndDecryptNotification(headers, rawBody) {
  assertLiveConfig()
  verifyNotificationSignature(headers, rawBody)
  const envelope = JSON.parse(rawBody.toString('utf8'))
  return decryptNotificationResource(envelope.resource)
}
