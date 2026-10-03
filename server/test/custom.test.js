import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.js'
import { billingTransition, canReadOrder, canUploadOrderFile, commercialSettings, hashRequest, nextStatus, validateRequirements } from '../src/custom-rules.js'
import { parseCustomMultipart, validateCustomImage } from '../src/custom-files.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('manual service is closed by default and permanent/legacy entitlements are excluded', () => {
  assert.equal(commercialSettings().mode, 'disabled')
  assert.equal(config.custom.permanentPolicy, 'excluded')
  assert.equal(config.custom.legacyMemberPolicy, 'excluded')
  assert.equal(config.custom.creditCost, null)
})

test('live mode refuses missing commercial approval or cost', () => {
  const previous = { ...config.custom }
  try {
    Object.assign(config.custom, { mode: 'live', commercialRulesApproved: false, creditCost: null })
    assert.throws(() => commercialSettings(), /商业规则未确认/)
    Object.assign(config.custom, { commercialRulesApproved: true, creditCost: 2 })
    assert.equal(commercialSettings().creditCost, 2)
    config.custom.permanentPolicy = 'unlimited'
    assert.throws(() => commercialSettings(), /商业规则未确认/)
  } finally { Object.assign(config.custom, previous) }
})

test('requirements need explicit human processing, billing, and guardian confirmations', () => {
  const base = { persons: 2, style: '圆润', features: '眼镜', size: '64×64',
    consentHumanThirdParty: true, confirmTerms: true }
  assert.deepEqual(validateRequirements(base).persons, 2)
  assert.equal(validateRequirements(base).consentVersion, 'manual-q-v1')
  assert.throws(() => validateRequirements({ ...base, confirmTerms: false }), /确认/)
  assert.throws(() => validateRequirements({ ...base, minorInPhoto: true }), /监护人/)
  assert.throws(() => validateRequirements({ ...base, persons: 9 }), /人数/)
  assert.notEqual(hashRequest(validateRequirements(base), 'photo-a'), hashRequest(validateRequirements(base), 'photo-b'))
})

test('customer and merchant access plus all major state transitions', () => {
  const order = { user_id: 'customer' }
  assert.equal(canReadOrder(order, 'customer', false), true)
  assert.equal(canReadOrder(order, 'stranger', false), false)
  assert.equal(canReadOrder(order, 'merchant', true), true)
  assert.equal(nextStatus('PENDING_ACCEPT', 'accept', 'MERCHANT'), 'IN_PROGRESS')
  assert.equal(nextStatus('IN_PROGRESS', 'preview', 'MERCHANT', { preview: true }), 'WAIT_Q_CONFIRM')
  assert.equal(nextStatus('WAIT_Q_CONFIRM', 'revise', 'CUSTOMER'), 'REVISION')
  assert.equal(nextStatus('REVISION', 'preview', 'MERCHANT', { preview: true }), 'WAIT_Q_CONFIRM')
  assert.equal(nextStatus('WAIT_Q_CONFIRM', 'approve', 'CUSTOMER'), 'WAIT_DELIVERY')
  assert.equal(nextStatus('WAIT_DELIVERY', 'deliver', 'MERCHANT', { finalQ: true, pattern: true, colors: true }), 'COMPLETED')
  assert.equal(nextStatus('PENDING_ACCEPT', 'reject', 'MERCHANT'), 'REJECTED')
  assert.equal(nextStatus('PENDING_ACCEPT', 'cancel', 'CUSTOMER'), 'CANCELLED')
  assert.equal(nextStatus('WAIT_DELIVERY', 'system_fail', 'SYSTEM'), 'SYSTEM_FAILED')
  assert.throws(() => nextStatus('PENDING_ACCEPT', 'accept', 'CUSTOMER'), /不允许/)
  assert.throws(() => nextStatus('COMPLETED', 'reject', 'MERCHANT'), /不允许/)
  assert.throws(() => nextStatus('WAIT_DELIVERY', 'deliver', 'MERCHANT', { finalQ: true }), /齐全/)
})

test('file upload ACL and reserve/settle/release semantics remain separate from direct generation', () => {
  const order = { user_id: 'customer', status: 'WAIT_DELIVERY', reserved_credits: 3 }
  assert.equal(canUploadOrderFile(order, 'customer', false, 'CHAT'), true)
  assert.equal(canUploadOrderFile(order, 'customer', false, 'Q_FINAL'), false)
  assert.equal(canUploadOrderFile(order, 'stranger', false, 'CHAT'), false)
  assert.equal(canUploadOrderFile(order, 'merchant', true, 'PATTERN'), true)
  assert.equal(canUploadOrderFile({ ...order, status: 'COMPLETED' }, 'merchant', true, 'CHAT'), false)
  assert.deepEqual(billingTransition(order, 'accept'), { release: 0, settle: 0 })
  assert.deepEqual(billingTransition(order, 'deliver'), { release: 0, settle: 3 })
  assert.deepEqual(billingTransition(order, 'reject'), { release: 3, settle: 0 })
  assert.deepEqual(billingTransition(order, 'system_fail'), { release: 3, settle: 0 })
})

test('private upload only accepts one structurally valid image', async () => {
  const jpg = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  const boundary = 'manual-custom-test'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpg, Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  const file = parseCustomMultipart(`multipart/form-data; boundary=${boundary}`, body)
  assert.deepEqual(file, jpg)
  assert.equal(await validateCustomImage(file), 'image/jpeg')
  await assert.rejects(() => validateCustomImage(Buffer.from([255, 216, 255, 0, 0])), /结构完整/)
  await assert.rejects(() => validateCustomImage(Buffer.from([255, 216, 255, 255, 255, 255, 255, 255, 255, 255, 255, 217])), /结构完整/)
  assert.throws(() => parseCustomMultipart('multipart/form-data; boundary=wrong', body), /无效/)
})
