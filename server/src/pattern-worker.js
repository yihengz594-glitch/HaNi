import { parentPort, workerData } from 'node:worker_threads'
import { generatePattern } from './pattern-core.js'

try {
  const imageBuffer = Buffer.from(workerData.imageBuffer)
  const result = await generatePattern(imageBuffer, workerData.settings)
  parentPort.postMessage({ ok: true, result })
} catch (error) {
  // Keep internal decoder/processing details out of user-visible task responses.
  parentPort.postMessage({ ok: false, errorCode: 'PATTERN_PROCESSING_FAILED' })
}
