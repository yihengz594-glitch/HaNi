import { failCustomOrderForSystem, listExpiredCustomFiles, listStaleCustomOrders, markCustomFileDeleted } from '../src/custom-store.js'
import { removePrivateFile } from '../src/custom-files.js'
import { config } from '../src/config.js'

const cutoff = new Date(Date.now() - config.custom.orderTimeoutDays * 86400000)
let failed = 0
for (const order of await listStaleCustomOrders(100)) {
  const result = await failCustomOrderForSystem({ orderId: order.id, staleBefore: cutoff })
  if (result.status === 'SYSTEM_FAILED') failed += 1
}

let removed = 0
for (const file of await listExpiredCustomFiles(500)) {
  await removePrivateFile(file.storage_key)
  await markCustomFileDeleted(file.id)
  removed += 1
}
console.log(`stale custom orders released: ${failed}; private files removed: ${removed}`)
