import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { generatePattern } from '../src/pattern-core.js'

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { generateLocalPattern } = require('../../pages/index/local-pattern-core.js')
const palette = require('../../pages/index/palette.js')
const paletteByCode = new Map(palette.map((color) => [color.code, color]))

function hashGrid(gridCodes) {
  return createHash('sha256').update(JSON.stringify(gridCodes)).digest('hex').slice(0, 16)
}

function boundsOfCodes(gridCodes) {
  let minRow = gridCodes.length
  let maxRow = -1
  let minColumn = gridCodes[0].length
  let maxColumn = -1
  gridCodes.forEach((row, rowIndex) => row.forEach((code, columnIndex) => {
    if (!code) return
    minRow = Math.min(minRow, rowIndex)
    maxRow = Math.max(maxRow, rowIndex)
    minColumn = Math.min(minColumn, columnIndex)
    maxColumn = Math.max(maxColumn, columnIndex)
  }))
  return { width: maxColumn - minColumn + 1, height: maxRow - minRow + 1 }
}

test('small grids preserve the selected canvas dimensions and real MARD colors', async () => {
  const cases = [
    [24, 24, 6], [27, 27, 6], [28, 28, 8], [32, 32, 8], [32, 36, 8],
    [35, 35, 8], [35, 42, 12], [39, 39, 8], [40, 40, 12], [45, 45, 12], [51, 51, 12]
  ]
  const imageBuffer = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  for (const [width, height, maxColors] of cases) {
    const result = await generatePattern(imageBuffer, {
      sizeMode: 'board', gridWidth: width, gridHeight: height, paletteSpec: '221', threshold: 'none'
    })
    assert.equal(result.columns, width)
    assert.equal(result.rows, height)
    assert.ok(result.totalBeads > 0)
    assert.ok(result.gridCodes.flat().filter(Boolean).every(code => paletteByCode.has(code)))
    assert.equal(result.gridCodes[0][0], '', 'the canvas background must remain blank')
  }
})

test('low-grid composition keeps the white cat body and gives the subject clear scale', async () => {
  const imageBuffer = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  const result = await generatePattern(imageBuffer, {
    sizeMode: 'board', gridWidth: 30, gridHeight: 30, paletteSpec: '221', threshold: 'none'
  })
  const bounds = boundsOfCodes(result.gridCodes)
  const edge = Math.max(result.columns, result.rows)
  assert.ok(Math.max(bounds.width, bounds.height) / edge >= 0.7, 'the subject should occupy at least 70% of the board')
  assert.ok(Math.max(bounds.width, bounds.height) / edge >= 0.95, 'compact fit uses almost all available cells without enlarging the board')
  assert.ok(result.gridCodes[19][15], 'light subject pixels in the torso must not be erased with the white background')
  const darkCodes = result.gridCodes.flat().filter((code) => {
    const color = paletteByCode.get(code)
    if (!color) return false
    return color.rgb[0] * 0.2126 + color.rgb[1] * 0.7152 + color.rgb[2] * 0.0722 < 90
  })
  assert.ok(darkCodes.length >= 8, 'eyes and the outer contour should leave visible dark features')
  const eyeRegion = result.gridCodes.slice(8, 17).flatMap((row) => row.slice(11, 24))
  const bluePaletteBeads = eyeRegion.filter((code) => {
    const color = paletteByCode.get(code)
    return color && color.rgb[2] > color.rgb[0] + 8 && color.rgb[2] >= color.rgb[1]
  })
  assert.ok(bluePaletteBeads.length > 0, 'the blue eye accents should survive as an available MARD color')
})

test('low-grid output uses one MARD code per cell and local/server results agree', async () => {
  const imageBuffer = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  const image = await loadImage(imageBuffer)
  const previousWx = globalThis.wx
  try {
    globalThis.wx = { createOffscreenCanvas: ({ width, height }) => createCanvas(width, height) }
    for (const size of [24, 30, 51]) {
      const settings = { sizeMode: 'board', gridWidth: size, gridHeight: size, paletteSpec: '221', threshold: 'none' }
      const serverResult = await generatePattern(imageBuffer, settings)
      const localResult = generateLocalPattern(image, settings, createCanvas(1200, 1200))
      assert.deepEqual(localResult, serverResult, `local generation should match the server at ${size}x${size}`)
      assert.equal(serverResult.totalBeads, serverResult.gridCodes.flat().filter(Boolean).length)
    }
  } finally {
    globalThis.wx = previousWx
  }
})

test('legacy 60 and 80 framing remains byte-for-byte equal for rollback', async () => {
  const baseline = {
    'cat-closeup.jpg': {
      60: '8d10708c284b2acc', 80: 'b726233d3fe248e6'
    },
    'cat-outline.jpg': {
      60: '1f45ca88116d2cb5', 80: 'ded4e24388eb0e01'
    }
  }
  for (const [filename, hashes] of Object.entries(baseline)) {
    const imageBuffer = await readFile(path.join(projectRoot, 'assets/pinbead-cat', filename))
    for (const [size, expectedHash] of Object.entries(hashes)) {
      const result = await generatePattern(imageBuffer, {
        sizeMode: 'board', gridWidth: Number(size), gridHeight: Number(size), paletteSpec: '221', threshold: 'none', layoutMode:'legacy'
      })
      assert.equal(hashGrid(result.gridCodes), expectedHash, `${filename} ${size}x${size} must not change`)
    }
  }
})
