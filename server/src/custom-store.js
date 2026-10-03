import crypto from 'node:crypto'
import { config } from './config.js'
import { query, withTransaction } from './store.js'
import { billingTransition, canReadOrder, canUploadOrderFile, CustomError, hashRequest, nextStatus, STATUS_LABELS, TERMINAL, validateRequirements } from './custom-rules.js'

const newId = () => crypto.randomUUID()
const json = (value) => JSON.stringify(value)
const missing = () => { throw new CustomError('工单不存在或无权访问', 404, 'NOT_FOUND') }

export async function getCustomAccess(userId) {
  const result = await query('SELECT is_merchant, is_tester FROM custom_access WHERE user_id = $1', [userId])
  return { merchant: result.rows[0]?.is_merchant === true, tester: result.rows[0]?.is_tester === true }
}

export async function updateCustomAccess({ adminId, userId, merchant, tester }) {
  if (typeof merchant !== 'boolean' || typeof tester !== 'boolean') throw new CustomError('权限值无效')
  return withTransaction(async (tx) => {
    const user = await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    if (!user.rows[0]) throw new CustomError('用户不存在', 404)
    const updated = await tx.query(
      `INSERT INTO custom_access (user_id, is_merchant, is_tester, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id) DO UPDATE SET
       is_merchant = EXCLUDED.is_merchant, is_tester = EXCLUDED.is_tester,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING is_merchant, is_tester`, [userId, merchant, tester, adminId])
    await tx.query(
      `INSERT INTO admin_audit_events (id,admin_id,event_type,target_id,detail_json,created_at)
       VALUES ($1,$2,'CUSTOM_ACCESS_CHANGED',$3,$4,NOW())`,
      [newId(), adminId, userId, json({ merchant, tester })])
    return updated.rows[0]
  })
}

async function event(tx, orderId, actorId, type, detail = {}) {
  await tx.query(
    `INSERT INTO custom_events (id,order_id,actor_id,event_type,detail_json,created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`, [newId(), orderId, actorId, type, json(detail)])
}

export async function createStagedFile({ userId, orderId, kind, key, mime, bytes, sha256 }) {
  const id = newId()
  await query(
    `INSERT INTO custom_files (id,owner_id,order_id,kind,storage_key,mime_type,byte_size,sha256,state,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGED',NOW() + INTERVAL '1 hour')`,
    [id, userId, orderId || null, kind, key, mime, bytes, sha256])
  return { id, kind, byteSize: bytes }
}

async function lockOrder(tx, orderId) {
  const result = await tx.query('SELECT * FROM custom_orders WHERE id = $1 FOR UPDATE', [orderId])
  return result.rows[0] || missing()
}

async function claimFile(tx, { fileId, orderId, ownerId, kind, source = false }) {
  const result = await tx.query('SELECT * FROM custom_files WHERE id = $1 FOR UPDATE', [fileId])
  const file = result.rows[0]
  if (!file || file.owner_id !== ownerId || file.kind !== kind || file.state !== 'STAGED' ||
      (source ? file.order_id !== null : file.order_id !== orderId) || new Date(file.expires_at) <= new Date()) {
    throw new CustomError('上传文件不存在、已过期或无权使用', 409, 'INVALID_FILE')
  }
  await tx.query(
    `UPDATE custom_files SET order_id=$2, state='VISIBLE', expires_at=NOW() + INTERVAL '1 year'
     WHERE id=$1`, [fileId, orderId])
  return file
}

export async function createCustomOrder({ userId, key, sourceFileId, input, service }) {
  const requirements = validateRequirements(input)
  const requestHash = hashRequest(requirements, sourceFileId)
  const cost = Number(service.creditCost || 0)
  return withTransaction(async (tx) => {
    const userResult = await tx.query('SELECT credits_remaining, credits_reserved FROM users WHERE id=$1 FOR UPDATE', [userId])
    const user = userResult.rows[0]
    if (!user) throw new CustomError('用户不存在', 404)
    const existing = await tx.query('SELECT * FROM custom_orders WHERE user_id=$1 AND idempotency_key=$2', [userId, key])
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new CustomError('重复请求的内容不一致', 409, 'IDEMPOTENCY_CONFLICT')
      return { order: existing.rows[0], reused: true }
    }
    if (Number(user.credits_remaining) - Number(user.credits_reserved) < cost) throw new CustomError('可用次数不足', 409, 'INSUFFICIENT_CREDITS')
    const sourceResult = await tx.query('SELECT * FROM custom_files WHERE id=$1 FOR UPDATE', [sourceFileId])
    const source = sourceResult.rows[0]
    if (!source || source.owner_id !== userId || source.kind !== 'SOURCE' || source.state !== 'STAGED' ||
        source.order_id !== null || new Date(source.expires_at) <= new Date()) {
      throw new CustomError('原图上传已失效，请重新上传', 409, 'INVALID_FILE')
    }
    const id = newId()
    if (cost) await tx.query('UPDATE users SET credits_reserved=credits_reserved+$2,updated_at=NOW() WHERE id=$1', [userId, cost])
    const result = await tx.query(
      `INSERT INTO custom_orders
       (id,user_id,idempotency_key,request_hash,requirements_json,status,billing_mode,credit_cost,reserved_credits,source_file_id,customer_seen_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING_ACCEPT',$6,$7,$7,$8,NOW()) RETURNING *`,
      [id, userId, key, requestHash, json(requirements), cost ? 'CREDITS' : 'TEST_NO_CHARGE', cost, sourceFileId])
    await claimFile(tx, { fileId: sourceFileId, orderId: id, ownerId: userId, kind: 'SOURCE', source: true })
    await event(tx, id, userId, 'CREATED', { creditCost: cost, billingMode: cost ? 'CREDITS' : 'TEST_NO_CHARGE' })
    return { order: result.rows[0], reused: false }
  })
}

export async function listCustomOrders({ userId, merchant = false }) {
  const result = merchant
    ? await query(`SELECT o.*, u.openid FROM custom_orders o JOIN users u ON u.id=o.user_id ORDER BY o.updated_at DESC LIMIT 100`)
    : await query('SELECT * FROM custom_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId])
  return result.rows.map((order) => ({
    id: order.id, status: order.status, statusLabel: STATUS_LABELS[order.status],
    persons: order.requirements_json?.persons, style: order.requirements_json?.style,
    creditCost: order.credit_cost, createdAt: order.created_at, updatedAt: order.updated_at,
    customerId: merchant ? order.user_id : undefined,
    unread: !(merchant ? order.merchant_seen_at : order.customer_seen_at) ||
      new Date(order.updated_at) > new Date(merchant ? order.merchant_seen_at : order.customer_seen_at)
  }))
}

export async function getCustomOrderDetail({ orderId, userId, merchant = false, markRead = true }) {
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (!canReadOrder(order, userId, merchant)) missing()
    const role = merchant && order.user_id !== userId ? 'MERCHANT' : 'CUSTOMER'
    const messages = await tx.query(
      `SELECT m.id,m.sender_id,m.sender_role,m.body,m.file_id,m.created_at
       FROM custom_messages m WHERE m.order_id=$1 ORDER BY m.created_at ASC LIMIT 500`, [orderId])
    const files = await tx.query(
      `SELECT id,kind,mime_type,byte_size,created_at FROM custom_files
       WHERE order_id=$1 AND state='VISIBLE' AND expires_at>NOW()`, [orderId])
    const visibleIds = new Set(files.rows.map((file) => file.id))
    const visible = (id) => id && visibleIds.has(id) ? id : null
    if (markRead) await tx.query(
      `UPDATE custom_orders SET ${role === 'MERCHANT' ? 'merchant_seen_at' : 'customer_seen_at'}=NOW() WHERE id=$1`, [orderId])
    return {
      order: {
        id: order.id, status: order.status, statusLabel: STATUS_LABELS[order.status],
        requirements: order.requirements_json, creditCost: order.credit_cost, billingMode: order.billing_mode,
        reservedCredits: order.reserved_credits, settledCredits: order.settled_credits,
        revisionCount: order.revision_count, sourceFileId: visible(order.source_file_id),
        previewFileId: visible(order.preview_file_id), finalQFileId: visible(order.final_q_file_id),
        patternFileId: visible(order.pattern_file_id), colorsFileId: visible(order.colors_file_id),
        createdAt: order.created_at, updatedAt: order.updated_at, completedAt: order.completed_at,
        customerId: merchant ? order.user_id : undefined
      }, messages: messages.rows.map((message) => ({ ...message, file_id: visible(message.file_id) })), files: files.rows, role
    }
  })
}

export async function getAuthorizedFile({ fileId, userId, merchant }) {
  const result = await query(
    `SELECT f.*,o.user_id FROM custom_files f JOIN custom_orders o ON o.id=f.order_id
      WHERE f.id=$1 AND f.state='VISIBLE' AND f.deleted_at IS NULL AND f.expires_at>NOW()`, [fileId])
  const file = result.rows[0]
  if (!file || !canReadOrder(file, userId, merchant)) missing()
  return file
}

export async function getUploadOrder({ orderId, userId, merchant, kind }) {
  const result = await query('SELECT id,user_id,status FROM custom_orders WHERE id=$1', [orderId])
  const order = result.rows[0]
  if (!order || !canReadOrder(order, userId, merchant)) missing()
  if (TERMINAL.has(order.status)) throw new CustomError('工单已结束', 409)
  if (!canUploadOrderFile(order, userId, merchant, kind)) throw new CustomError('无权上传此类文件', 403)
  return order
}

export async function sendCustomMessage({ orderId, userId, merchant, key, body, fileId }) {
  const text = String(body || '').trim()
  if (text.length > 2000 || (!text && !fileId)) throw new CustomError('消息需包含文字或图片，文字不超过2000字')
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (!canReadOrder(order, userId, merchant)) missing()
    if (TERMINAL.has(order.status)) throw new CustomError('工单已结束', 409)
    const existing = await tx.query(
      'SELECT * FROM custom_messages WHERE order_id=$1 AND sender_id=$2 AND idempotency_key=$3',
      [orderId, userId, key])
    if (existing.rows[0]) {
      if (existing.rows[0].body !== text || existing.rows[0].file_id !== (fileId || null)) throw new CustomError('重复消息内容不一致', 409)
      return existing.rows[0]
    }
    if (fileId) await claimFile(tx, { fileId, orderId, ownerId: userId, kind: 'CHAT' })
    const role = merchant && order.user_id !== userId ? 'MERCHANT' : 'CUSTOMER'
    const result = await tx.query(
      `INSERT INTO custom_messages (id,order_id,sender_id,sender_role,idempotency_key,body,file_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [newId(), orderId, userId, role, key, text, fileId || null])
    await tx.query('UPDATE custom_orders SET updated_at=NOW() WHERE id=$1', [orderId])
    return result.rows[0]
  })
}

export async function actOnCustomOrder({ orderId, userId, merchant, key, action, fileIds = {}, reason = '' }) {
  if (reason.length > 500) throw new CustomError('原因过长')
  const actionHash = crypto.createHash('sha256').update(json({ action, fileIds, reason: reason.trim() })).digest('hex')
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (!canReadOrder(order, userId, merchant)) missing()
    const role = merchant && order.user_id !== userId ? 'MERCHANT' : 'CUSTOMER'
    const previous = await tx.query('SELECT * FROM custom_actions WHERE order_id=$1 AND actor_id=$2 AND idempotency_key=$3', [orderId, userId, key])
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== actionHash) throw new CustomError('重复操作内容不一致', 409)
      return previous.rows[0].result_json
    }
    if (action === 'reject' && !reason.trim()) throw new CustomError('拒单必须填写原因')
    if (action === 'revise' && !reason.trim()) throw new CustomError('请填写修改意见')
    if (action === 'revise' && order.revision_count >= config.custom.includedRevisions) throw new CustomError('已达到约定的免费修改次数，请先与商家沟通', 409)
    const next = nextStatus(order.status, action, role, {
      preview: Boolean(fileIds.preview), finalQ: Boolean(fileIds.finalQ),
      pattern: Boolean(fileIds.pattern), colors: Boolean(fileIds.colors)
    })
    if (action === 'preview') {
      await claimFile(tx, { fileId: fileIds.preview, orderId, ownerId: userId, kind: 'Q_PREVIEW' })
    }
    if (action === 'deliver') {
      for (const [name, kind] of [['finalQ', 'Q_FINAL'], ['pattern', 'PATTERN'], ['colors', 'COLORS']]) {
        await claimFile(tx, { fileId: fileIds[name], orderId, ownerId: userId, kind })
      }
    }
    const { release, settle } = billingTransition(order, action)
    if (release || settle) {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [order.user_id])
      await tx.query(
        `UPDATE users SET credits_reserved=credits_reserved-$2,
         credits_remaining=credits_remaining-$3,updated_at=NOW() WHERE id=$1
         AND credits_reserved >= $2 AND credits_remaining >= $3`,
        [order.user_id, release + settle, settle]).then((r) => {
          if (!r.rowCount) throw new Error('预占余额不一致')
        })
      if (settle) await tx.query(
        `INSERT INTO credit_ledger (id,user_id,delta,balance_after,source_type,source_ref,feature,created_at)
         SELECT $1,id,$2,credits_remaining,'MANUAL_CUSTOM',$3,'manual_q_custom',NOW() FROM users WHERE id=$4`,
        [newId(), -settle, orderId, order.user_id])
    }
    const updated = await tx.query(
      `UPDATE custom_orders SET status=$2, updated_at=NOW(),
       reserved_credits=reserved_credits-$3,settled_credits=settled_credits+$4,
       preview_file_id=COALESCE($5,preview_file_id), final_q_file_id=COALESCE($6,final_q_file_id),
       pattern_file_id=COALESCE($7,pattern_file_id),colors_file_id=COALESCE($8,colors_file_id),
       revision_count=revision_count+$9,completed_at=CASE WHEN $2='COMPLETED' THEN NOW() ELSE completed_at END
       WHERE id=$1 RETURNING id,status,reserved_credits,settled_credits`,
      [orderId, next, release + settle, settle, fileIds.preview || null, fileIds.finalQ || null,
        fileIds.pattern || null, fileIds.colors || null, action === 'revise' ? 1 : 0])
    if (TERMINAL.has(next)) {
      await tx.query(`UPDATE custom_files SET expires_at=NOW()+($2::int * INTERVAL '1 day') WHERE order_id=$1 AND state='VISIBLE'`,
        [orderId, config.custom.retentionDays])
    }
    await event(tx, orderId, userId, action.toUpperCase(), { status: next, reason: reason.trim(), released: release, settled: settle })
    const output = { ...updated.rows[0], statusLabel: STATUS_LABELS[next] }
    await tx.query(
      'INSERT INTO custom_actions (order_id,actor_id,idempotency_key,action_type,request_hash,result_json) VALUES ($1,$2,$3,$4,$5,$6)',
      [orderId, userId, key, action, actionHash, json(output)])
    return output
  })
}

export async function adminRefundCustomOrder({ adminId, orderId, reason }) {
  if (!String(reason || '').trim() || String(reason).length > 500) throw new CustomError('特殊退款必须填写原因')
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (order.status !== 'COMPLETED' || !order.settled_credits || order.refunded_credits) throw new CustomError('该工单不能重复退款', 409)
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [order.user_id])
    await tx.query('UPDATE users SET credits_remaining=credits_remaining+$2,updated_at=NOW() WHERE id=$1', [order.user_id, order.settled_credits])
    await tx.query(
      `INSERT INTO credit_ledger (id,user_id,delta,balance_after,source_type,source_ref,feature,created_at)
       SELECT $1,id,$2,credits_remaining,'MANUAL_REFUND',$3,'manual_q_custom',NOW() FROM users WHERE id=$4`,
      [newId(), order.settled_credits, orderId, order.user_id])
    await tx.query('UPDATE custom_orders SET refunded_credits=$2,updated_at=NOW() WHERE id=$1', [orderId, order.settled_credits])
    await tx.query(
      `INSERT INTO admin_audit_events (id,admin_id,event_type,target_id,detail_json,created_at)
       VALUES ($1,$2,'CUSTOM_SPECIAL_REFUND',$3,$4,NOW())`,
      [newId(), adminId, orderId, json({ reason: String(reason).trim(), credits: order.settled_credits })])
    return { refundedCredits: order.settled_credits }
  })
}

export async function failCustomOrderForSystem({ orderId, actorId = null, staleBefore = null }) {
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId)
    if (TERMINAL.has(order.status)) return { status: order.status, released: 0 }
    if (staleBefore && new Date(order.updated_at) > staleBefore) return { status: order.status, released: 0 }
    nextStatus(order.status, 'system_fail', 'SYSTEM')
    const amount = billingTransition(order, 'system_fail').release
    if (amount) {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [order.user_id])
      const result = await tx.query(
        'UPDATE users SET credits_reserved=credits_reserved-$2,updated_at=NOW() WHERE id=$1 AND credits_reserved >= $2',
        [order.user_id, amount])
      if (!result.rowCount) throw new Error('预占余额不一致')
    }
    await tx.query(
      `UPDATE custom_orders SET status='SYSTEM_FAILED',reserved_credits=0,updated_at=NOW() WHERE id=$1`, [orderId])
    await tx.query(`UPDATE custom_files SET expires_at=NOW()+($2::int * INTERVAL '1 day') WHERE order_id=$1 AND state='VISIBLE'`,
      [orderId, config.custom.retentionDays])
    await event(tx, orderId, actorId, 'SYSTEM_FAILED', { released: amount })
    return { status: 'SYSTEM_FAILED', released: amount }
  })
}

export async function listExpiredCustomFiles(limit = 100) {
  const result = await query(
    `SELECT id,storage_key FROM custom_files WHERE state <> 'DELETED' AND expires_at < NOW()
     ORDER BY expires_at ASC LIMIT $1`, [limit])
  return result.rows
}

export async function listStaleCustomOrders(limit = 100) {
  const result = await query(
    `SELECT id FROM custom_orders WHERE status NOT IN ('COMPLETED','CANCELLED','REJECTED','SYSTEM_FAILED')
     AND updated_at < NOW()-($1::int * INTERVAL '1 day') ORDER BY updated_at ASC LIMIT $2`,
    [config.custom.orderTimeoutDays, limit])
  return result.rows
}

export async function markCustomFileDeleted(id) {
  await query(`UPDATE custom_files SET state='DELETED',deleted_at=NOW() WHERE id=$1 AND state<>'DELETED'`, [id])
}
