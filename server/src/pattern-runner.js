import { Worker } from 'node:worker_threads'

const MAX_WORKERS = 2
const MAX_QUEUE = 4
const TASK_TIMEOUT_MS = 120_000
const queue = []
let activeWorkers = 0

export function runPatternJob(imageBuffer, settings) {
  if (activeWorkers >= MAX_WORKERS && queue.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('生成队列繁忙，请稍后重试'), { code: 'QUEUE_FULL' }))
  }
  return new Promise((resolve, reject) => {
    queue.push({ imageBuffer: Buffer.from(imageBuffer), settings, resolve, reject })
    dispatch()
  })
}

function dispatch() {
  while (activeWorkers < MAX_WORKERS && queue.length) {
    const job = queue.shift()
    activeWorkers += 1
    const worker = new Worker(new URL('./pattern-worker.js', import.meta.url), {
      workerData: { imageBuffer: job.imageBuffer, settings: job.settings }
    })
    let finished = false
    const timeout = setTimeout(() => {
      if (finished) return
      finished = true
      worker.terminate().finally(() => {
        job.reject(Object.assign(new Error('生成任务超时'), { code: 'TASK_TIMEOUT' }))
        activeWorkers -= 1
        dispatch()
      })
    }, TASK_TIMEOUT_MS)
    timeout.unref()

    worker.once('message', (message) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      worker.terminate().finally(() => {
        if (message && message.ok) job.resolve(message.result)
        else job.reject(Object.assign(new Error('图纸处理失败'), { code: 'PATTERN_PROCESSING_FAILED' }))
        activeWorkers -= 1
        dispatch()
      })
    })
    worker.once('error', () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      worker.terminate().finally(() => {
        job.reject(Object.assign(new Error('图纸处理失败'), { code: 'PATTERN_PROCESSING_FAILED' }))
        activeWorkers -= 1
        dispatch()
      })
    })
    worker.once('exit', (code) => {
      if (finished || code === 0) return
      finished = true
      clearTimeout(timeout)
      job.reject(Object.assign(new Error('图纸处理失败'), { code: 'PATTERN_PROCESSING_FAILED' }))
      activeWorkers -= 1
      dispatch()
    })
  }
}

export function getPatternQueueState() {
  return { activeWorkers, queuedJobs: queue.length, maxWorkers: MAX_WORKERS, maxQueue: MAX_QUEUE }
}
