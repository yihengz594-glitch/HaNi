import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import catalog from '../../shared/product-catalog.js'
import { parseImageUpload, validateImageSignature } from '../src/multipart-image.js'
import { runPatternJob } from '../src/pattern-runner.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('versioned product catalog keeps prices in fen and permanent benefit separate', () => {
  const { PRODUCTS } = catalog
  assert.deepEqual(PRODUCTS.map(({ id, amountFen, creditAmount, productType }) => ({ id, amountFen, creditAmount, productType })), [
    { id: 'credits10_v2', amountFen: 888, creditAmount: 10, productType: 'CREDITS' },
    { id: 'credits30_v2', amountFen: 1888, creditAmount: 30, productType: 'CREDITS' },
    { id: 'credits100_v2', amountFen: 6666, creditAmount: 100, productType: 'CREDITS' },
    { id: 'permanent_v1', amountFen: 8888, creditAmount: 0, productType: 'PERMANENT' }
  ])
})

test('multipart image parser accepts one supported image and bounded fields', () => {
  const boundary = 'smoke-boundary-123'
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="taskType"\r\n\r\nDIRECT_PATTERN\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="settings"\r\n\r\n{"gridWidth":52}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="cat.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  const parsed = parseImageUpload(`multipart/form-data; boundary=${boundary}`, body)
  assert.equal(parsed.fields.taskType, 'DIRECT_PATTERN')
  assert.equal(parsed.fields.settings, '{"gridWidth":52}')
  assert.deepEqual(parsed.imageBuffer, png)
  assert.doesNotThrow(() => validateImageSignature(parsed.imageBuffer))
  assert.throws(() => validateImageSignature(Buffer.from('not an image')), { code: 'IMAGE_TYPE' })
})

test('server worker runs the existing MARD pattern pipeline on an included image', async () => {
  const image = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  const result = await runPatternJob(image, {
    sizeMode: 'board', gridWidth: 26, gridHeight: 26, paletteSpec: '221', threshold: 'none'
  })
  assert.equal(result.rows, 26)
  assert.equal(result.columns, 26)
  assert.equal(result.gridCodes.length, 26)
  assert.ok(result.gridCodes.every((row) => row.length === 26))
  assert.ok(result.totalBeads > 0 && result.totalBeads <= 26 * 26)
  assert.ok(result.gridCodes.flat().every((code) => code === '' || /^[A-Z]\d{1,2}$/.test(code)))
})
